/**
 * Starter selection limits in co-op: each player picks with half the solo point budget and at most three pokemon.
 * @module
 */

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { COOP_MAX_OWNED } from "#coop/coop-ownership";

/**
 * Each player's starter point budget: half the solo limit in co-op (10 → 5), so that the two parties together cost
 * no more than one solo party. Not rounded, so it follows whatever the solo limit becomes.
 * @param limit - The solo run value limit
 */
export function applyCoopValueLimit(limit: number): number {
  return globalScene.gameMode.isCoop ? limit / 2 : limit;
}

/** How many starters the local player may pick: their share of the party in co-op, a full party otherwise. */
export function getStarterPickLimit(): number {
  return globalScene.gameMode.isCoop ? COOP_MAX_OWNED : PLAYER_PARTY_MAX_SIZE;
}
