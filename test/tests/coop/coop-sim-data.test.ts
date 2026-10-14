import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { CoopSession, setCoopSession } from "#coop/coop-session";
import { createAccountSnapshot, getPokemonSimData, getWorldSimData, type SimGameDataSource } from "#coop/coop-sim-data";
import { createLoopbackPair } from "#coop/loopback-transport";
import { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import type { DexEntry } from "#types/dex-data";
import { afterEach, describe, expect, it } from "vitest";

/** A stand-in for `GameData` holding only what the simulation reads. */
function createFakeGameData(): SimGameDataSource {
  const dexData = {
    [SpeciesId.BULBASAUR]: { caughtAttr: 3n },
    [SpeciesId.CHARMANDER]: { caughtAttr: 0n },
    [SpeciesId.SQUIRTLE]: { caughtAttr: 1n },
  } as unknown as SimGameDataSource["dexData"];
  const unlocks: Partial<Record<Unlockables, boolean>> = { [Unlockables.EVIOLITE]: true };
  return {
    trainerId: 1234,
    secretId: 5678,
    dexData,
    starterData: {
      [SpeciesId.BULBASAUR]: { eggMoves: 0b0101 },
      [SpeciesId.CHARMANDER]: { eggMoves: 0 },
    } as unknown as SimGameDataSource["starterData"],
    getSpeciesCount(predicate: (entry: DexEntry) => boolean) {
      return Object.values(dexData).filter(entry => predicate(entry)).length;
    },
    isUnlocked: (unlockable: Unlockables) => !!unlocks[unlockable],
  };
}

const hostSnapshot: CoopAccountSnapshot = {
  trainerId: 1,
  secretId: 2,
  caughtSpecies: [SpeciesId.PIKACHU],
  eggMoves: { [SpeciesId.BULBASAUR]: 0b1000 },
  unlocks: [Unlockables.MINI_BLACK_HOLE],
};

const guestSnapshot: CoopAccountSnapshot = {
  trainerId: 3,
  secretId: 4,
  caughtSpecies: [SpeciesId.EEVEE, SpeciesId.SNORLAX],
  eggMoves: { [SpeciesId.BULBASAUR]: 0b0010 },
  unlocks: [],
};

function startGuestSession(): CoopSession {
  const session = new CoopSession("guest", createLoopbackPair().guest);
  setCoopSession(session);
  return session;
}

describe("coop-sim-data", () => {
  afterEach(() => {
    setCoopSession(null);
  });

  it("wraps the local game data outside co-op", () => {
    const gameData = createFakeGameData();
    for (const data of [getWorldSimData(gameData), getPokemonSimData(7, gameData)]) {
      expect(data.trainerId).toBe(1234);
      expect(data.secretId).toBe(5678);
      expect(data.isSpeciesCaught(SpeciesId.BULBASAUR)).toBe(true);
      expect(data.isSpeciesCaught(SpeciesId.CHARMANDER)).toBe(false);
      expect(data.getCaughtSpeciesCount()).toBe(2);
      expect(data.getEggMoveBits(SpeciesId.BULBASAUR)).toBe(0b0101);
      expect(data.isUnlocked(Unlockables.EVIOLITE)).toBe(true);
      expect(data.isUnlocked(Unlockables.MINI_BLACK_HOLE)).toBe(false);
    }
  });

  it("snapshots the account", () => {
    const snapshot = createAccountSnapshot(createFakeGameData());
    expect(snapshot).toEqual({
      trainerId: 1234,
      secretId: 5678,
      caughtSpecies: [SpeciesId.BULBASAUR, SpeciesId.SQUIRTLE],
      eggMoves: { [SpeciesId.BULBASAUR]: 0b0101 },
      unlocks: [Unlockables.EVIOLITE],
    });
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("reads world data from the host snapshot in co-op", () => {
    const session = startGuestSession();
    session.setAccountSnapshot("host", hostSnapshot);
    session.setAccountSnapshot("guest", guestSnapshot);

    const data = getWorldSimData(createFakeGameData());
    expect(data.trainerId).toBe(1);
    expect(data.secretId).toBe(2);
    expect(data.isSpeciesCaught(SpeciesId.PIKACHU)).toBe(true);
    expect(data.isSpeciesCaught(SpeciesId.BULBASAUR)).toBe(false);
    expect(data.getCaughtSpeciesCount()).toBe(1);
    expect(data.isUnlocked(Unlockables.MINI_BLACK_HOLE)).toBe(true);
    expect(data.isUnlocked(Unlockables.EVIOLITE)).toBe(false);
  });

  it("reads pokemon data from the owner snapshot in co-op", () => {
    const session = startGuestSession();
    session.setAccountSnapshot("host", hostSnapshot);
    session.setAccountSnapshot("guest", guestSnapshot);
    session.ownership.set(1, "host");
    session.ownership.set(2, "guest");
    const gameData = createFakeGameData();

    expect(getPokemonSimData(1, gameData).getEggMoveBits(SpeciesId.BULBASAUR)).toBe(0b1000);
    expect(getPokemonSimData(2, gameData).getEggMoveBits(SpeciesId.BULBASAUR)).toBe(0b0010);
    expect(getPokemonSimData(2, gameData).isSpeciesCaught(SpeciesId.SNORLAX)).toBe(true);
    expect(getPokemonSimData(2, gameData).getEggMoveBits(SpeciesId.CHARMANDER)).toBe(0);
    // Unowned pokemon (enemies, encounter pokemon) belong to the world, so the host decides.
    expect(getPokemonSimData(99, gameData).trainerId).toBe(1);
  });

  it("throws when a snapshot is missing", () => {
    startGuestSession();
    expect(() => getWorldSimData(createFakeGameData())).toThrow("missing co-op account snapshot for host");
  });
});
