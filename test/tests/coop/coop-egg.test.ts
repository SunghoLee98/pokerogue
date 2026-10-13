import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { Egg } from "#data/egg";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-egg",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

// Hatching depends on each account's eggs and draws random numbers, so co-op holds it until the run ends (spec 3.7).
describe("co-op egg hatching", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingWave(3)
      .startingLevel(100)
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.HYPER_VOICE, MoveId.SPLASH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  it("counts the waves down without hatching the eggs", async () => {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    const ready = new Egg({ species: SpeciesId.MAGIKARP, hatchWaves: 1 });
    const later = new Egg({ species: SpeciesId.MAGIKARP, hatchWaves: 5 });
    game.scene.gameData.eggs = [ready, later];

    game.move.select(MoveId.HYPER_VOICE, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SPLASH));
    await game.phaseInterceptor.to("SelectModifierPhase", false);

    expect(game.phaseInterceptor.phaseLog).toContain("EggLapsePhase");
    expect(game.phaseInterceptor.phaseLog).not.toContain("EggHatchPhase");
    expect(game.scene.gameData.eggs).toEqual([ready, later]);
    expect(ready.hatchWaves).toBe(0);
    expect(later.hatchWaves).toBe(4);
  });
});
