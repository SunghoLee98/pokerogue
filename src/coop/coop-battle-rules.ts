/**
 * Battle rules that differ in co-op (spec 3.3, 3.9).
 *
 * Every battle is a double battle so that each player has a field slot. Battles that are fixed to one enemy in solo
 * (the classic final boss, single-enemy mystery encounters) keep their one enemy and are fought 2v1.
 * Outside co-op every function here returns what the solo game would use.
 * @module
 */

import type { GameMode } from "#app/game-mode";
import { globalScene } from "#app/global-scene";
import { coopSession } from "#coop/coop-session";
import type { Pokemon } from "#field/pokemon";
import type { NumberHolder } from "#utils/common";

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

/** Phase one of the co-op classic final boss has every stat, HP included, multiplied by this (spec 3.9). */
export const COOP_FINAL_BOSS_STAT_MULTIPLIER = 1.5;

/**
 * Boost a stat of the co-op classic final boss while it is in its first form, making up for facing two players.
 * The form change into phase two recalculates the stats without the boost.
 * @param pokemon - The pokemon whose stat is being calculated
 * @param stat - The stat value, boosted in place (rounded down)
 */
export function applyCoopBossStatMultiplier(pokemon: Pokemon, stat: NumberHolder): void {
  if (coopSession && !pokemon.isPlayer() && pokemon.formIndex === 0 && globalScene.currentBattle?.isClassicFinalBoss) {
    stat.value = Math.floor(stat.value * COOP_FINAL_BOSS_STAT_MULTIPLIER);
  }
}
