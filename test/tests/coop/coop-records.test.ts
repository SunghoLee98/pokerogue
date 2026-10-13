import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { getCoopRunHistoryFields } from "#coop/coop-records";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand, waitForCoop } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { SessionSaveData } from "#types/save-data";
import type { GameStatsUiHandler } from "#ui/game-stats-ui-handler";
import type { RunHistoryUiHandler } from "#ui/run-history-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [SpeciesId.BULBASAUR, SpeciesId.CHARMANDER],
  eggMoves: { [SpeciesId.BULBASAUR]: 1 },
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-records",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

// Co-op runs are kept in their own run history tab, apart from solo runs (spec 3.7).
describe("co-op records", () => {
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
      .startingLevel(50)
      .enemyLevel(50)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.MEMENTO, MoveId.SPLASH]);
    localStorage.clear();
  });

  afterEach(() => {
    setCoopSession(null);
    localStorage.clear();
  });

  /** Lose a co-op run as the host and return the run history entry the game over saved. */
  async function loseCoopRun(): Promise<SessionSaveData> {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, {
      role: "host",
      start: startInfo(),
      transport: partner.localTransport,
      participants: { host: "alice", guest: "bob" },
    });
    const saveRunHistory = vi.spyOn(game.scene.gameData, "saveRunHistory");
    game.move.select(MoveId.MEMENTO, 0);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.MEMENTO));
    await game.phaseInterceptor.to("PostGameOverPhase", false);
    await waitForCoop(() => saveRunHistory.mock.calls.length > 0);
    return saveRunHistory.mock.calls[0][0];
  }

  it("marks a co-op run's history entry, without the account snapshots", async () => {
    const entry = await loseCoopRun();

    expect(entry.coop).toBeDefined();
    expect(entry.coop?.localRole).toBe("host");
    expect(entry.coop?.participants).toEqual({ host: "alice", guest: "bob" });
    expect(Object.keys(entry.coop?.ownership ?? {})).toHaveLength(2);
    expect(entry.coop?.accounts.host.caughtSpecies).toEqual([]);
    expect(entry.coop?.accounts.guest.eggMoves).toEqual({});
  });

  it("adds nothing to a solo entry", () => {
    expect(getCoopRunHistoryFields()).toEqual({});
  });

  it("shows solo runs and co-op runs in their own tabs", async () => {
    const coopEntry = await loseCoopRun();
    setCoopSession(null);
    const { coop: _, ...soloEntry } = { ...coopEntry, timestamp: coopEntry.timestamp - 1000 };
    await game.scene.gameData.saveRunHistory(soloEntry as SessionSaveData, false);
    expect(Object.keys(await game.scene.gameData.getRunHistoryData())).toHaveLength(2);

    await game.scene.ui.setOverlayMode(UiMode.RUN_HISTORY);
    const handler = game.scene.ui.getHandler() as RunHistoryUiHandler;
    const runs = () => handler["runs"].map(run => run.entryData.entry);
    await waitForCoop(() => runs().length > 0);
    expect(runs()).toHaveLength(1);
    expect(runs()[0].coop).toBeUndefined();

    handler.processInput(Button.RIGHT);
    await waitForCoop(() => runs()[0]?.coop !== undefined);
    expect(runs()).toHaveLength(1);
    const texts = handler["runs"][0].list.map(o => (o as Phaser.GameObjects.Text).text);
    expect(texts.some(text => text?.includes("bob"))).toBe(true);

    handler.processInput(Button.LEFT);
    await waitForCoop(() => runs()[0]?.coop === undefined);
    expect(runs()).toHaveLength(1);
  });

  it("shows the co-op counts in the game stats", async () => {
    await game.runToTitle();
    game.scene.gameData.gameStats.coopSessionsPlayed = 7;
    game.scene.gameData.gameStats.coopSessionsWon = 2;
    await game.scene.ui.setOverlayMode(UiMode.GAME_STATS);
    const handler = game.scene.ui.getHandler() as GameStatsUiHandler;
    const labels: string[] = handler["statLabels"].map(label => label.text);
    const values: string[] = handler["statValues"].map(value => value.text);

    expect(values[labels.indexOf(coopText("statCoopRuns"))]).toBe("7");
    expect(values[labels.indexOf(coopText("statCoopWins"))]).toBe("2");
  });
});
