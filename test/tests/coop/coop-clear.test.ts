import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import { achvs } from "#system/achv";
import { GameData } from "#system/game-data";
import { GameStats } from "#system/game-stats";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
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
  seed: "coop-clear",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

// A co-op clear is not a classic clear (spec 3.7): both players get the co-op clear achievement instead.
describe("co-op clears and records", () => {
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
      .moveset([MoveId.SPLASH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(): Promise<void> {
    const partner = new CoopTestPartner("guest");
    await startCoopBattle(game, { role: "guest", start: startInfo(), transport: partner.localTransport });
  }

  /** End the run as won, the way the last wave of a classic run does. */
  async function win(): Promise<void> {
    game.scene.phaseManager.clearPhaseQueue();
    game.scene.phaseManager.pushNew("GameOverPhase", true);
    game.endPhase();
    await game.phaseInterceptor.to("PostGameOverPhase", false);
  }

  it("gives the co-op clear achievement instead of the classic clear", async () => {
    await start();
    const { gameData } = game.scene;
    const validateAchv = vi.spyOn(game.scene, "validateAchv");
    const ribbonsBefore = gameData.starterData[SpeciesId.BULBASAUR].classicWinCount;
    const sessionsWonBefore = gameData.gameStats.sessionsWon;

    await win();

    expect(gameData.achvUnlocks[achvs.COOP_VICTORY.id]).toBeTruthy();
    expect(gameData.gameStats.coopSessionsWon).toBe(1);
    expect(validateAchv).not.toHaveBeenCalledWith(achvs.CLASSIC_VICTORY);
    expect(validateAchv).not.toHaveBeenCalledWith(achvs.UNEVOLVED_CLASSIC_VICTORY);
    expect(gameData.gameStats.sessionsWon).toBe(sessionsWonBefore);
    expect(gameData.starterData[SpeciesId.BULBASAUR].classicWinCount).toBe(ribbonsBefore);
    const log = game.phaseInterceptor.phaseLog;
    expect(log).not.toContain("UnlockPhase");
    expect(log).not.toContain("RibbonModifierRewardPhase");
    expect(log).not.toContain("GameOverModifierRewardPhase");
    expect(gameData.unlocks[Unlockables.ENDLESS_MODE]).toBe(false);
  });

  it("counts a co-op run apart from classic runs", async () => {
    const classicBefore = game.scene.gameData.gameStats.classicSessionsPlayed;
    await start();
    expect(game.scene.gameData.gameStats.coopSessionsPlayed).toBe(1);
    expect(game.scene.gameData.gameStats.classicSessionsPlayed).toBe(classicBefore);
  });

  it("names the achievement without a translation", () => {
    expect(achvs.COOP_VICTORY.name).toBe(coopText("coopVictoryName"));
    expect(achvs.COOP_VICTORY.description).toBe(coopText("coopVictoryDescription"));
    expect(achvs.COOP_VICTORY.score).toBe(achvs.CLASSIC_VICTORY.score);
  });

  it("keeps the co-op stats in the system save", () => {
    const stats = new GameStats({ coopSessionsPlayed: 3, coopSessionsWon: 2 });
    const parsed = GameData.parseSystemData(JSON.stringify({ gameStats: stats }));
    expect(parsed.gameStats.coopSessionsPlayed).toBe(3);
    expect(parsed.gameStats.coopSessionsWon).toBe(2);
  });
});
