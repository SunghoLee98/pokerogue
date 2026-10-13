/**
 * Continuing a saved co-op run (spec 3.8).
 *
 * Only the host keeps the save. When the host continues it, the host sends the saved session as JSON and both clients
 * load that same JSON with {@linkcode resumeCoopRun}, so both start from the same state.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { arrangeCoopParty } from "#coop/coop-field";
import { COOP_SESSION_SLOT } from "#coop/coop-game-start";
import { CoopOwnership } from "#coop/coop-ownership";
import type { CoopRole } from "#coop/coop-protocol";
import { restoreCoopRewardCounters } from "#coop/coop-reward";
import { normalizeCoopSaveData } from "#coop/coop-save";
import { CoopSession, coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopTransport } from "#coop/coop-transport";
import type { SessionSaveData } from "#types/save-data";

/** `GameData.initSessionFromData` is private; co-op resumes through it the way loading a slot does. */
type SessionLoader = { initSessionFromData(data: SessionSaveData): Promise<void> };

/**
 * Load a saved co-op run on this client. Both clients call it with the same JSON (the host's save):
 * the session (roles, ownership, both account snapshots, counters) is opened first, so that everything the load
 * creates sees co-op, then the run is loaded as a solo continue would load it, into the co-op slot.
 * The caller continues like the title screen after loading a slot (`EncounterPhase` with `loaded`).
 * @throws If the JSON is not a co-op save
 */
export async function resumeCoopRun(role: CoopRole, transport: CoopTransport, sessionJson: string): Promise<void> {
  const { gameData } = globalScene;
  const data = gameData.parseSessionData(sessionJson);
  if (!data.coop) {
    throw new Error("not a co-op save");
  }
  const coop = normalizeCoopSaveData(data.coop);

  const session = new CoopSession(role, transport, CoopOwnership.fromJSON(coop.ownership));
  session.setAccountSnapshot("host", coop.accounts.host);
  session.setAccountSnapshot("guest", coop.accounts.guest);
  session.timedEvent = coop.timedEvent;
  session.participants = { ...coop.participants };
  session.restoreDecisionCount(coop.decisionSeq);
  setCoopSession(session);
  restoreCoopRewardCounters(session, { gen: coop.rewardGen, seq: coop.rewardSeq });

  globalScene.sessionSlotId = COOP_SESSION_SLOT;
  await (gameData as unknown as SessionLoader).initSessionFromData(data);
  // The load picks the game mode from the save, which is plain classic.
  globalScene.gameMode.isCoop = true;
}

/**
 * Queue the summons after continuing a co-op run, in place of the title screen's solo summons:
 * each player's pokemon goes to their own slot (an empty slot for a wiped player), and there is no "switch?"
 * question (`CheckSwitchPhase`), which depends on each client's settings.
 * @returns Whether co-op queued the summons (the caller must skip its own)
 */
export function queueCoopResumeSummons(): boolean {
  const session = coopSession;
  if (!session) {
    return false;
  }
  const fighters = arrangeCoopParty(session);
  if (!fighters) {
    return false;
  }
  for (const [fieldIndex, fighter] of fighters.entries()) {
    if (fighter) {
      globalScene.phaseManager.pushNew("SummonPhase", fieldIndex, true, true);
    }
  }
  return true;
}
