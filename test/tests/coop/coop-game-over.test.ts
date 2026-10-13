import { pokerogueApi } from "#api/api";
import { settings } from "#app/global-settings-manager";
import * as appConstants from "#constants/app-constants";
import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-game-over",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

describe("co-op game over", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let retries: boolean;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingLevel(50)
      .enemyLevel(50)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.MEMENTO, MoveId.SPLASH]);
    retries = settings.general.enableRetries;
    settings.general.enableRetries = true;
  });

  afterEach(() => {
    settings.general.enableRetries = retries;
    setCoopSession(null);
  });

  it("offers no retry and asks no new-clear question", async () => {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    const showText = vi.spyOn(game.scene.ui, "showText");
    const newclear = vi.spyOn(pokerogueApi.savedata.session, "newclear").mockResolvedValue(true);
    vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(false);

    game.move.select(MoveId.MEMENTO, 0);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.MEMENTO));
    await game.phaseInterceptor.to("PostGameOverPhase", false);

    expect(showText.mock.calls.some(([text]) => text === i18next.t("battle:retryBattle"))).toBe(false);
    expect(newclear).not.toHaveBeenCalled();
  });
});
