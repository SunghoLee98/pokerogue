/**
 * The simulation data source: account values that change battle results, read without assuming whose account it is.
 *
 * Outside co-op these read the local `globalScene.gameData`, exactly as the game did before.
 * In co-op both clients must read the same values, so they come from shared account snapshots:
 * - world-level values (enemy shininess, reward pool unlocks, critical capture dex count) use the host's snapshot;
 * - pokemon-level values (egg moves, caught-species evolution and form conditions) use the owner's snapshot,
 *   and the host's for pokemon nobody owns (enemies, encounter pokemon).
 * @module
 */

import { globalScene } from "#app/global-scene";
import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { coopSession } from "#coop/coop-session";
import type { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import type { GameData } from "#system/game-data";
import { getEnumValues } from "#utils/enums";

/** Account values the simulation reads. */
export interface SimAccountData {
  readonly trainerId: number;
  readonly secretId: number;
  /** Whether the species' dex entry has been caught */
  isSpeciesCaught(speciesId: SpeciesId): boolean;
  /** The number of species caught in the dex */
  getCaughtSpeciesCount(): number;
  /** Unlocked egg move bits of a root species */
  getEggMoveBits(rootSpeciesId: SpeciesId): number;
  isUnlocked(unlockable: Unlockables): boolean;
}

/** The parts of {@linkcode GameData} the simulation data source reads. */
export type SimGameDataSource = Pick<
  GameData,
  "trainerId" | "secretId" | "dexData" | "starterData" | "getSpeciesCount" | "isUnlocked"
>;

/** Reads the local game data the same way the game code did before the data source existed. */
class GameDataSimAccount implements SimAccountData {
  private readonly gameData: SimGameDataSource;

  constructor(gameData: SimGameDataSource) {
    this.gameData = gameData;
  }

  get trainerId(): number {
    return this.gameData.trainerId;
  }

  get secretId(): number {
    return this.gameData.secretId;
  }

  isSpeciesCaught(speciesId: SpeciesId): boolean {
    return !!this.gameData.dexData[speciesId].caughtAttr;
  }

  getCaughtSpeciesCount(): number {
    return this.gameData.getSpeciesCount(d => !!d.caughtAttr);
  }

  getEggMoveBits(rootSpeciesId: SpeciesId): number {
    return this.gameData.starterData[rootSpeciesId].eggMoves;
  }

  isUnlocked(unlockable: Unlockables): boolean {
    return this.gameData.isUnlocked(unlockable);
  }
}

class SnapshotSimAccount implements SimAccountData {
  readonly trainerId: number;
  readonly secretId: number;
  private readonly caught: ReadonlySet<number>;
  private readonly eggMoves: Readonly<Record<number, number>>;
  private readonly unlocks: ReadonlySet<number>;

  constructor(snapshot: CoopAccountSnapshot) {
    this.trainerId = snapshot.trainerId;
    this.secretId = snapshot.secretId;
    this.caught = new Set(snapshot.caughtSpecies);
    this.eggMoves = snapshot.eggMoves;
    this.unlocks = new Set(snapshot.unlocks);
  }

  isSpeciesCaught(speciesId: SpeciesId): boolean {
    return this.caught.has(speciesId);
  }

  getCaughtSpeciesCount(): number {
    return this.caught.size;
  }

  getEggMoveBits(rootSpeciesId: SpeciesId): number {
    return this.eggMoves[rootSpeciesId] ?? 0;
  }

  isUnlocked(unlockable: Unlockables): boolean {
    return this.unlocks.has(unlockable);
  }
}

const snapshotAccounts = new WeakMap<CoopAccountSnapshot, SnapshotSimAccount>();

function fromSnapshot(snapshot: CoopAccountSnapshot): SimAccountData {
  let account = snapshotAccounts.get(snapshot);
  if (!account) {
    account = new SnapshotSimAccount(snapshot);
    snapshotAccounts.set(snapshot, account);
  }
  return account;
}

/** Capture the simulation-relevant parts of an account, to share with the co-op peer. */
export function createAccountSnapshot(gameData: SimGameDataSource): CoopAccountSnapshot {
  const caughtSpecies: number[] = [];
  for (const [speciesId, entry] of Object.entries(gameData.dexData)) {
    if (entry.caughtAttr) {
      caughtSpecies.push(Number(speciesId));
    }
  }
  const eggMoves: Record<number, number> = {};
  for (const [speciesId, entry] of Object.entries(gameData.starterData)) {
    if (entry.eggMoves) {
      eggMoves[Number(speciesId)] = entry.eggMoves;
    }
  }
  const unlocks = getEnumValues(Unlockables).filter(u => gameData.isUnlocked(u));
  return { trainerId: gameData.trainerId, secretId: gameData.secretId, caughtSpecies, eggMoves, unlocks };
}

/**
 * Account data for world-level values: the local game data in solo play, the host's snapshot in co-op.
 * @param gameData - The local game data; defaults to `globalScene.gameData`
 */
export function getWorldSimData(gameData: SimGameDataSource = globalScene.gameData): SimAccountData {
  return coopSession ? fromSnapshot(coopSession.getAccountSnapshot("host")) : new GameDataSimAccount(gameData);
}

/**
 * Account data for values that belong to one pokemon: the local game data in solo play,
 * the owner's snapshot in co-op (the host's if nobody owns the pokemon).
 * @param pokemonId - The pokemon's `id`
 * @param gameData - The local game data; defaults to `globalScene.gameData`
 */
export function getPokemonSimData(
  pokemonId: number,
  gameData: SimGameDataSource = globalScene.gameData,
): SimAccountData {
  if (!coopSession) {
    return new GameDataSimAccount(gameData);
  }
  return fromSnapshot(coopSession.getAccountSnapshot(coopSession.ownership.get(pokemonId) ?? "host"));
}
