import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { getGameMode } from "#app/game-mode";
import { createCoopGameMode } from "#coop/coop-game-start";
import { COOP_MAX_OWNED } from "#coop/coop-ownership";
import { getStarterPickLimit } from "#coop/coop-starter-rules";
import { GameModes } from "#enums/game-modes";
import { GameManager } from "#test/framework/game-manager";
import { getRunValueLimit } from "#ui/starter-select-ui-utils";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("co-op starter rules", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  it("co-op is a flag on classic", () => {
    const coop = createCoopGameMode();
    expect(coop.modeId).toBe(GameModes.CLASSIC);
    expect(coop.isClassic).toBe(true);
    expect(coop.isCoop).toBe(true);
    expect(getGameMode(GameModes.CLASSIC).isCoop).toBe(false);
  });

  it("keeps the solo run value limit in co-op, as the budget both players share", () => {
    game.scene.gameMode = getGameMode(GameModes.CLASSIC);
    expect(getRunValueLimit()).toBe(10);
    game.scene.gameMode = createCoopGameMode();
    expect(getRunValueLimit()).toBe(10);
  });

  it("limits picks to three in co-op", () => {
    game.scene.gameMode = getGameMode(GameModes.CLASSIC);
    expect(getStarterPickLimit()).toBe(PLAYER_PARTY_MAX_SIZE);
    game.scene.gameMode = createCoopGameMode();
    expect(getStarterPickLimit()).toBe(COOP_MAX_OWNED);
  });
});
