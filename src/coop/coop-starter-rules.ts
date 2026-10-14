/**
 * Starter selection limits in co-op: each player picks at most three pokemon.
 * The starter point budget is the solo one, shared by both players (see `CoopStarterSelection`).
 * @module
 */

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { COOP_MAX_OWNED } from "#coop/coop-ownership";

/** How many starters the local player may pick: their share of the party in co-op, a full party otherwise. */
export function getStarterPickLimit(): number {
  return globalScene.gameMode.isCoop ? COOP_MAX_OWNED : PLAYER_PARTY_MAX_SIZE;
}
