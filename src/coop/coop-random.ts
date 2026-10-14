/**
 * Random number helpers for game code that is unseeded in solo play but must agree between co-op clients.
 * Outside co-op they call the original unseeded functions with the same arguments, so solo play is unchanged.
 * @module
 */

import { coopSession } from "#coop/coop-session";
import { randInt, randIntRange, randSeedInt, randSeedIntRange } from "#utils/common";

/** {@linkcode randInt} in solo play, {@linkcode randSeedInt} in co-op. */
export function coopRandInt(range: number, min = 0): number {
  return coopSession ? randSeedInt(range, min) : randInt(range, min);
}

/** {@linkcode randIntRange} in solo play, {@linkcode randSeedIntRange} in co-op. */
export function coopRandIntRange(min: number, max: number): number {
  return coopSession ? randSeedIntRange(min, max) : randIntRange(min, max);
}
