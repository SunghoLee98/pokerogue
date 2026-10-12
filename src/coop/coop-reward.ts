/**
 * Rewards in co-op (spec 3.5).
 * @module
 */

import { coopSession } from "#coop/coop-session";

/** Lures raise the chance of double battles, which co-op always has: they are left out of the rewards (spec 3.5). */
export function coopExcludesLures(): boolean {
  return coopSession !== null;
}
