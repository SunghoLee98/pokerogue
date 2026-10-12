/**
 * Catching in co-op (spec 3.3): the caught pokemon belongs to the thrower, and the thrower's account decides the
 * critical capture chance.
 * @module
 */

import { coopSession } from "#coop/coop-session";
import { getPokemonSimData, getWorldSimData, type SimAccountData } from "#coop/coop-sim-data";

/**
 * Account data for the critical capture chance: the thrower's account (spec 3.3, 4.1).
 * In solo, and when the thrower is unknown, the same world data as before.
 * @param throwerId - The `id` of the player pokemon that threw the ball
 */
export function getCaptureSimData(throwerId?: number): SimAccountData {
  return coopSession && throwerId !== undefined ? getPokemonSimData(throwerId) : getWorldSimData();
}
