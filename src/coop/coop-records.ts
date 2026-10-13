/**
 * Co-op clears and records (spec 3.7).
 *
 * A co-op clear is not a classic clear: it gives no classic achievements, wins, ribbons, vouchers or unlocks, and
 * both players get the co-op clear achievement instead. Co-op runs are counted apart from classic runs.
 * @module
 */

import { globalScene } from "#app/global-scene";
import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { type CoopSessionSaveData, createCoopSaveData } from "#coop/coop-save";
import { coopSession } from "#coop/coop-session";
import { achvs } from "#system/achv";

/**
 * Count a co-op run as it starts, in place of the classic run count.
 * @returns Whether the run is a co-op run (it then counts as nothing else)
 */
export function recordCoopRunStart(): boolean {
  if (!coopSession) {
    return false;
  }
  globalScene.gameData.gameStats.coopSessionsPlayed++;
  return true;
}

/**
 * A won co-op run: the co-op clear achievement and win count, on each player's own account.
 * @returns Whether the run is a co-op run, which then skips the classic clear rewards
 */
export function awardCoopVictory(): boolean {
  if (!coopSession) {
    return false;
  }
  globalScene.validateAchv(achvs.COOP_VICTORY);
  globalScene.gameData.gameStats.coopSessionsWon++;
  return true;
}

/**
 * The co-op fields of a run history entry (`GameOverPhase.getRunHistoryEntry`): the run's `coop` block with the
 * local player's role, so the history can tell co-op runs apart and name the partner. The account snapshots are left
 * out, as the history only shows the run.
 * @returns `{ coop }` in co-op; nothing outside it
 */
export function getCoopRunHistoryFields(): { coop?: CoopSessionSaveData } {
  const session = coopSession;
  if (!session) {
    return {};
  }
  const data = createCoopSaveData(session);
  const withoutLists = (snapshot: CoopAccountSnapshot): CoopAccountSnapshot => ({
    ...snapshot,
    caughtSpecies: [],
    eggMoves: {},
    unlocks: [],
  });
  return {
    coop: {
      ...data,
      accounts: { host: withoutLists(data.accounts.host), guest: withoutLists(data.accounts.guest) },
      localRole: session.localRole,
    },
  };
}
