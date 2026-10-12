import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { modifierPool } from "#modifiers/modifier-pools";
import type { WeightedModifierType } from "#modifiers/modifier-type";
import { GameManager } from "#test/framework/game-manager";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const LURES = ["LURE", "SUPER_LURE", "MAX_LURE"];

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-lure",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

/** The weight each lure has in the reward pool for the current party. */
function lureWeights(game: GameManager): Record<string, number> {
  const party = game.scene.getPlayerParty();
  const weights: Record<string, number> = {};
  for (const weighted of Object.values(modifierPool).flat() as WeightedModifierType[]) {
    const { id } = weighted.modifierType;
    if (LURES.includes(id)) {
      weights[id] = weighted.weight instanceof Function ? weighted.weight(party, 0) : weighted.weight;
    }
  }
  return weights;
}

describe("co-op lures", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.disableTrainerWaves().startingWave(3).enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  it("are left out of the co-op reward pool", async () => {
    await startCoopBattle(game, { role: "host", start: startInfo() });

    expect(lureWeights(game)).toEqual({ LURE: 0, SUPER_LURE: 0, MAX_LURE: 0 });
  });

  it("stay in the solo reward pool", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);

    const weights = lureWeights(game);
    expect(Object.keys(weights).sort()).toEqual([...LURES].sort());
    expect(Object.values(weights).every(w => w > 0)).toBe(true);
  });
});
