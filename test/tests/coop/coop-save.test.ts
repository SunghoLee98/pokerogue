import { COOP_PROTOCOL_VERSION, type CoopAccountSnapshot } from "#coop/coop-protocol";
import { normalizeCoopSaveData } from "#coop/coop-save";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: trainerId + 100,
  caughtSpecies: [1, 4],
  eggMoves: { 1: 3 },
  unlocks: [0],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-save",
  accounts: { host: snapshot(11), guest: snapshot(22) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: "Halloween",
});

describe("co-op session saves", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.battleStyle(null).disableTrainerWaves().enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  it("carries the co-op metadata", async () => {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, {
      role: "host",
      start: startInfo(),
      transport: partner.localTransport,
      participants: { host: "alice", guest: "bob" },
    });
    const session = coopSession!;
    session.nextDecisionSeq();
    session.nextDecisionSeq();

    const data = game.scene.gameData.getSessionSaveData();

    expect(data.coop).toEqual({
      protocol: COOP_PROTOCOL_VERSION,
      participants: { host: "alice", guest: "bob" },
      ownership: session.ownership.toJSON(),
      accounts: { host: snapshot(11), guest: snapshot(22) },
      timedEvent: "Halloween",
      decisionSeq: 2,
      rewardGen: -1,
      rewardSeq: 0,
    });
    const party = game.scene.getPlayerParty();
    expect(data.coop?.ownership).toEqual({ [party[0].id]: "host", [party[1].id]: "guest" });
    // It survives the JSON the save goes through.
    expect(JSON.parse(JSON.stringify(data)).coop).toEqual(data.coop);
  });

  it("solo saves have no co-op key", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);

    const data = game.scene.gameData.getSessionSaveData();

    expect("coop" in data).toBe(false);
    expect(JSON.stringify(data)).not.toContain('"coop"');
  });
});

describe("normalizeCoopSaveData", () => {
  it("turns the empty values the save server returns as null back into empty values", () => {
    const fromServer = {
      protocol: 4,
      participants: { host: "alice", guest: "bob" },
      ownership: null,
      accounts: {
        host: { trainerId: 1, secretId: 2, caughtSpecies: null, eggMoves: null, unlocks: null },
        guest: { trainerId: 3, secretId: 0, caughtSpecies: [4], eggMoves: { 4: 1 }, unlocks: [2] },
      },
      timedEvent: null,
      decisionSeq: 0,
      rewardGen: 0,
      rewardSeq: 0,
    };

    expect(normalizeCoopSaveData(fromServer)).toEqual({
      ...fromServer,
      ownership: {},
      accounts: {
        host: { trainerId: 1, secretId: 2, caughtSpecies: [], eggMoves: {}, unlocks: [] },
        guest: fromServer.accounts.guest,
      },
    });
  });

  it("fills in counters the server dropped as zero", () => {
    const normalized = normalizeCoopSaveData({
      protocol: 4,
      participants: { host: "alice", guest: "bob" },
      ownership: { 1: "host" },
      accounts: { host: snapshot(1), guest: snapshot(2) },
    });
    expect(normalized).toMatchObject({ timedEvent: null, decisionSeq: 0, rewardGen: 0, rewardSeq: 0 });
  });
});
