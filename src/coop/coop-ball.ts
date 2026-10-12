/**
 * Balls in co-op (spec 3.3): both players can throw, and with two enemies out each thrower picks the target.
 *
 * Solo play cannot throw a ball while two enemies are out. Co-op battles are always double, so the thrower picks the
 * target in the usual target selection screen, and the ball command is made again with that target.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { coopSession } from "#coop/coop-session";
import type { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import type { PokeballType } from "#enums/pokeball";
import { UiMode } from "#enums/ui-mode";
import type { EnemyPokemon } from "#field/pokemon";
import type { CommandPhase } from "#phases/command-phase";

/**
 * A move whose targets are exactly the enemies in front of the user, with no effect that changes them.
 * Only used to have the target selection screen offer the enemies; the move itself is never used.
 */
const BALL_TARGETING_MOVE = MoveId.SLEEP_TALK;

let chosenTarget: BattlerIndex | null = null;

/**
 * Make a ball command aimed at a chosen target.
 * @param target - The enemy the ball is thrown at
 * @param handle - Makes the ball command, e.g. `() => phase.handleCommand(Command.BALL, ball)`
 */
export function withCoopBallTarget<T>(target: BattlerIndex, handle: () => T): T {
  chosenTarget = target;
  try {
    return handle();
  } finally {
    chosenTarget = null;
  }
}

/** The targets of a ball: the chosen one in co-op, otherwise every active enemy as in solo. */
export function applyCoopBallTarget(targets: BattlerIndex[]): BattlerIndex[] {
  return coopSession && chosenTarget !== null ? [chosenTarget] : targets;
}

/** The pokemon a co-op ball is aimed at (`undefined` in solo, where it is the one enemy out). */
export function getCoopBallTargetPokemon(targets: readonly BattlerIndex[]): EnemyPokemon | undefined {
  return coopSession ? (globalScene.getField()[targets[0]] as EnemyPokemon | undefined) : undefined;
}

/**
 * With two enemies out, let the thrower pick one; the ball command is then made again with that target.
 * Cancelling goes back to the ball list.
 * @returns Whether the target selection was opened (always in co-op)
 */
export function openCoopBallTargetSelect(phase: CommandPhase, ball: PokeballType): boolean {
  if (!coopSession) {
    return false;
  }
  const ui = globalScene.ui;
  ui.setMode(UiMode.TARGET_SELECT, phase.getFieldIndex(), BALL_TARGETING_MOVE, (targets: BattlerIndex[]) => {
    if (targets.length === 0) {
      ui.setMode(UiMode.BALL);
      return;
    }
    if (withCoopBallTarget(targets[0], () => phase.handleCommand(Command.BALL, ball))) {
      // Close the command menu left open under the ball list, as the ball list does after a solo throw.
      ui.setMode(UiMode.COMMAND, phase.getFieldIndex());
      ui.setMode(UiMode.MESSAGE);
    }
  });
  return true;
}

/**
 * Whether a co-op ball must not be thrown because the team's last one of that kind is already gone.
 * Both players may pick the last ball in the same turn; the first throw uses it.
 */
export function isCoopBallUnavailable(ball: PokeballType): boolean {
  return coopSession !== null && globalScene.pokeballCounts[ball] <= 0;
}
