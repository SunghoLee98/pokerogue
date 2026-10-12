/**
 * Battle rules that differ in co-op (spec 3.3, 3.9).
 *
 * Every battle is a double battle so that each player has a field slot. Battles that are fixed to one enemy in solo
 * (the classic final boss, single-enemy mystery encounters) keep their one enemy and are fought 2v1.
 * Outside co-op every function here returns what the solo game would use.
 * @module
 */

import type { GameMode } from "#app/game-mode";
import { coopSession } from "#coop/coop-session";

/** Whether every battle must be a double battle: always in co-op. */
export function coopForcesDouble(): boolean {
  return coopSession !== null;
}

/**
 * The number of enemies in a wild battle.
 * @param double - Whether the battle is a double battle
 * @returns `double ? 2 : 1` as in solo, except that the co-op classic final boss stays alone
 */
export function getCoopWildEnemyCount(gameMode: GameMode, waveIndex: number, double: boolean): number {
  if (coopSession && gameMode.isClassic && gameMode.isWaveFinal(waveIndex)) {
    return 1;
  }
  return double ? 2 : 1;
}

/**
 * Whether a mystery encounter battle is a double battle.
 * The encounter config decides how many enemies there are; co-op only keeps both player slots.
 * @param double - What the encounter config asks for
 */
export function getCoopEncounterDouble(double: boolean): boolean {
  return coopForcesDouble() || double;
}
