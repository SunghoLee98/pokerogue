/**
 * Account progress in co-op (spec 3.7): each client writes only its own player's account.
 *
 * What a pokemon earns for an account (the dex "caught" entry, best IVs, candies, unlocked abilities, natures and egg
 * moves, ribbons) goes to its owner's account only. The partner's client sees the same pokemon and only marks it as
 * seen. Enemies have no owner, so both players see them as usual.
 *
 * These writes never touch the shared simulation: they only change the local `gameData`, which the simulation does
 * not read in co-op (it reads the account snapshots taken when the run started).
 * @module
 */

import { coopSession } from "#coop/coop-session";
import type { Pokemon } from "#field/pokemon";
import type { GameData } from "#system/game-data";

/**
 * Whether what this pokemon earns goes to the local account.
 * Always in solo. In co-op: the local player's own pokemon, and pokemon nobody owns (enemies); not the partner's.
 * Party pokemon without a recorded owner count as the host's, as everywhere in co-op.
 */
export function coopCreditsLocalAccount(pokemon: Pokemon): boolean {
  const session = coopSession;
  if (!session) {
    return true;
  }
  const owner = session.ownership.get(pokemon.id) ?? (pokemon.isPlayer() ? "host" : undefined);
  return owner === undefined || owner === session.localRole;
}

/**
 * `GameData.setPokemonCaught` for the partner's pokemon: the local account only sees it (spec 3.7).
 * The seen count stays, as the pokemon was not encountered again.
 * @returns The result for `setPokemonCaught` (no new starter), or `null` when the catch is the local player's
 */
export function recordCoopPartnerCatch(gameData: GameData, pokemon: Pokemon): Promise<boolean> | null {
  if (coopCreditsLocalAccount(pokemon)) {
    return null;
  }
  gameData.setPokemonSeen(pokemon, false);
  return Promise.resolve(false);
}

/**
 * A party pokemon turned into a new one (Weird Dream's transformation, a Global Trade System trade) keeps its owner
 * (spec 3.10): the new pokemon belongs to whoever owned the old one.
 */
export function inheritCoopOwner(previous: Pokemon, next: Pokemon): void {
  const owner = coopSession?.ownership.get(previous.id);
  if (owner) {
    coopSession?.ownership.set(next.id, owner);
  }
}

/**
 * `EggLapsePhase` in co-op: the eggs count the wave down but do not hatch (spec 3.7). Hatching depends on each
 * account's eggs and plays scenes on one client only, so it waits until the run is over: eggs that are ready hatch at
 * the first wave the player wins outside co-op.
 * @returns Whether co-op took over the phase (the phase then ends without hatching)
 */
export function lapseCoopEggs(eggs: readonly { hatchWaves: number }[]): boolean {
  if (!coopSession) {
    return false;
  }
  for (const egg of eggs) {
    egg.hatchWaves = Math.max(egg.hatchWaves - 1, 0);
  }
  return true;
}
