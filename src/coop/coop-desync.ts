/**
 * Comparing state hash sequences between the two co-op clients.
 * @module
 */

import type { CoopMessage } from "#coop/coop-protocol";

/** One state hash checkpoint, as carried by the `checksum` message. */
export type CoopChecksum = Omit<Extract<CoopMessage, { t: "checksum" }>, "t">;

/** The first checkpoint at which two hash sequences disagree. */
export interface CoopDesync {
  index: number;
  /** `undefined` if the expected sequence ended first */
  expected: CoopChecksum | undefined;
  /** `undefined` if the actual sequence ended first */
  actual: CoopChecksum | undefined;
}

function sameChecksum(a: CoopChecksum, b: CoopChecksum): boolean {
  return a.wave === b.wave && a.turn === b.turn && a.hash === b.hash;
}

/**
 * Find the first checkpoint where two hash sequences differ in wave, turn or hash, or where one sequence ends early.
 * @returns The first difference, or `null` if the sequences are identical
 */
export function findFirstDesync(expected: readonly CoopChecksum[], actual: readonly CoopChecksum[]): CoopDesync | null {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index++) {
    const e = expected[index] as CoopChecksum | undefined;
    const a = actual[index] as CoopChecksum | undefined;
    if (!e || !a || !sameChecksum(e, a)) {
      return { index, expected: e, actual: a };
    }
  }
  return null;
}
