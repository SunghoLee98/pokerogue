import { pokerogueApi } from "#api/api";
import { getSessionDataLocalStorageKey, loggedInUser } from "#app/account";
import * as appConstants from "#constants/app-constants";
import { COOP_PROTOCOL_VERSION, type CoopAccountSnapshot, type CoopRole } from "#coop/coop-protocol";
import { coopSaveServer, isCoopSlotRangeError, normalizeCoopSaveData } from "#coop/coop-save";
import { COOP_SESSION_SLOT, coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("who saves a co-op session", () => {
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

  const sessionKey = (slot: number) => getSessionDataLocalStorageKey(slot);
  const systemKey = () => `data_${loggedInUser?.username}`;

  /** Start a co-op battle and use the real `saveAll` (the test framework replaces it). */
  async function startAs(role: CoopRole): Promise<void> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    vi.mocked(game.scene.gameData.saveAll).mockRestore();
    localStorage.removeItem(sessionKey(COOP_SESSION_SLOT));
    localStorage.removeItem(systemKey());
  }

  it("the host saves the session in the co-op slot", async () => {
    await startAs("host");

    await expect(game.scene.gameData.saveAll(true, true)).resolves.toBe(true);

    const saved = await game.scene.gameData.getSession(COOP_SESSION_SLOT);
    expect(saved?.coop?.participants).toBeDefined();
    expect(saved?.waveIndex).toBe(game.scene.currentBattle.waveIndex);
    expect(localStorage.getItem(systemKey())).toBeTruthy();
  });

  it("the guest saves its account data but never the session", async () => {
    await startAs("guest");

    await expect(game.scene.gameData.saveAll(true, true)).resolves.toBe(true);
    // Save and quit reads the cached session; the guest has none.
    await expect(game.scene.gameData.saveAll(true, true, true, true)).resolves.toBe(true);

    expect(localStorage.getItem(sessionKey(COOP_SESSION_SLOT))).toBeFalsy();
    expect(localStorage.getItem(systemKey())).toBeTruthy();
  });

  it("solo saves the session in its own slot", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    vi.mocked(game.scene.gameData.saveAll).mockRestore();

    await game.scene.gameData.saveAll(true, true);

    const saved = await game.scene.gameData.getSession(game.scene.sessionSlotId);
    expect(game.scene.sessionSlotId).not.toBe(COOP_SESSION_SLOT);
    expect(saved).toBeDefined();
    expect(saved && "coop" in saved).toBe(false);
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

describe("save server check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    coopSaveServer.reset();
  });

  it("recognizes the error of a server without the co-op slot", () => {
    expect(isCoopSlotRangeError("slot id 5 out of range\n")).toBe(true);
    expect(isCoopSlotRangeError("save does not exist\n")).toBe(false);
    expect(isCoopSlotRangeError('{"seed":"abc"}')).toBe(false);
    expect(isCoopSlotRangeError(null)).toBe(false);
  });

  it("asks an online server for the co-op slot once", async () => {
    vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(false);
    const get = vi.spyOn(pokerogueApi.savedata.session, "get").mockResolvedValue("slot id 5 out of range\n");

    await expect(coopSaveServer.supportsCoop()).resolves.toBe(false);
    await expect(coopSaveServer.supportsCoop()).resolves.toBe(false);

    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0]).toMatchObject({ slot: COOP_SESSION_SLOT });
  });

  it("accepts a server that knows the co-op slot", async () => {
    vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(false);
    vi.spyOn(pokerogueApi.savedata.session, "get").mockResolvedValue("save does not exist\n");
    await expect(coopSaveServer.supportsCoop()).resolves.toBe(true);
  });

  it("asks again after a network failure", async () => {
    vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(false);
    const get = vi.spyOn(pokerogueApi.savedata.session, "get").mockResolvedValueOnce(null);
    get.mockResolvedValueOnce("save does not exist\n");

    await expect(coopSaveServer.supportsCoop()).resolves.toBe(false);
    await expect(coopSaveServer.supportsCoop()).resolves.toBe(true);
  });

  it("needs no server offline", async () => {
    vi.spyOn(appConstants, "bypassLogin", "get").mockReturnValue(true);
    const get = vi.spyOn(pokerogueApi.savedata.session, "get");
    await expect(coopSaveServer.supportsCoop()).resolves.toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
