/**
 * Continuing a saved co-op run (spec 3.8).
 *
 * Only the host keeps the save. When the host continues it, the host sends the saved session as JSON and both clients
 * load that same JSON with {@linkcode resumeCoopRun}, so both start from the same state.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { attachCoopChecksums } from "#coop/coop-checksum";
import { type CoopConnection, type CoopLocalInfo, getLocalCoopInfo, hostCoop } from "#coop/coop-connect";
import { type HeldCoopRoom, watchCoopConnection } from "#coop/coop-exit";
import { arrangeCoopParty, queueCoopSwitchQuestions, soloAsksSwitch } from "#coop/coop-field";
import type { CoopHandshakeResult } from "#coop/coop-handshake";
import { CoopVersionMismatchError, performHandshake } from "#coop/coop-handshake";
import { CoopOwnership } from "#coop/coop-ownership";
import type { CoopRole } from "#coop/coop-protocol";
import { restoreCoopRewardCounters } from "#coop/coop-reward";
import { normalizeCoopSaveData } from "#coop/coop-save";
import { COOP_SESSION_SLOT, CoopSession, coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopTransport, Unsubscribe } from "#coop/coop-transport";
import { attachCoopWaitButton } from "#coop/coop-wait-button";
import { ReliableCoopTransport } from "#coop/reliable-coop-transport";
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
  // The loaded run starts a wave without saving it again.
  session.waveStartSave = sessionJson;
  setCoopSession(session);
  watchCoopConnection(transport);
  attachCoopWaitButton(session);
  attachCoopChecksums(session);
  restoreCoopRewardCounters(session, { gen: coop.rewardGen, seq: coop.rewardSeq });

  globalScene.sessionSlotId = COOP_SESSION_SLOT;
  await (gameData as unknown as SessionLoader).initSessionFromData(data);
  // The load picks the game mode from the save, which is plain classic.
  globalScene.gameMode.isCoop = true;
}

/**
 * Queue the summons after continuing a co-op run, in place of the title screen's solo summons:
 * each player's pokemon goes to their own slot (an empty slot for a wiped player), then each player is asked
 * "switch?" about their own pokemon where solo would ask (see `takeOverCoopSwitchQuestion`).
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
  if (soloAsksSwitch()) {
    queueCoopSwitchQuestions(fighters);
  }
  return true;
}

/** The partner who joined is not the one saved with the run. */
export class CoopWrongAccountError extends Error {
  /** `true` on the guest's client, which was turned away; `false` on the host's, which turned the partner away */
  readonly turnedAway: boolean;

  constructor(turnedAway: boolean) {
    super("not the saved co-op partner");
    this.name = "CoopWrongAccountError";
    this.turnedAway = turnedAway;
  }
}

/** The saved co-op run in the co-op slot, or `null` if there is none. */
export async function readCoopSave(): Promise<SessionSaveData | null> {
  try {
    const data = await globalScene.gameData.getSession(COOP_SESSION_SLOT);
    return data?.coop ? data : null;
  } catch (error) {
    console.error("could not read the co-op save:", error);
    return null;
  }
}

/**
 * Whether the partner who joined is the one saved with the run: same account name and trainer id.
 * @param partnerRole - The partner's role in the run
 */
export function isSavedPartner(
  saved: Pick<SessionSaveData, "coop">,
  partner: CoopHandshakeResult,
  partnerRole: CoopRole = "guest",
): boolean {
  const coop = normalizeCoopSaveData(saved.coop);
  return (
    partner.peerAccountName === coop.participants[partnerRole]
    && partner.peerTrainerId === coop.accounts[partnerRole].trainerId
  );
}

/**
 * Host: continue a saved run. Get a join code, wait for the guest and check it is the saved partner, then send the
 * saved session to the guest.
 * @returns The connection and the JSON both clients load
 * @throws {@linkcode CoopWrongAccountError} if another account joined; it was told so and the connection is closed
 */
export async function hostCoopResume(
  transport: CoopTransport,
  saved: SessionSaveData,
  onJoinCode: (joinCode: string) => void,
  local: CoopLocalInfo = getLocalCoopInfo(),
): Promise<{ connection: CoopConnection; json: string }> {
  const connection = await hostCoop(transport, onJoinCode, { ...local, resume: true });
  if (!isSavedPartner(saved, connection)) {
    connection.transport.send({ t: "bye", reason: "wrongAccount" });
    connection.transport.close();
    throw new CoopWrongAccountError(false);
  }
  const json = JSON.stringify(saved);
  connection.transport.send({ t: "resume", session: json });
  return { connection, json };
}

/** What the player continuing a saved run sends: the JSON both clients load, and our role in that run. */
export interface CoopResumeInfo {
  session: string;
  role: CoopRole;
}

/**
 * Joiner: wait for the saved session from the player continuing a run.
 * @throws {@linkcode CoopWrongAccountError} if the host turned us away, or an error if the host left
 */
export function waitForCoopResume(transport: CoopTransport): Promise<CoopResumeInfo> {
  return new Promise((resolve, reject) => {
    const unsubscribes: Unsubscribe[] = [];
    const finish = (settle: () => void) => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
      settle();
    };
    unsubscribes.push(
      transport.onStatusChange(status => {
        if (status === "closed") {
          finish(() => reject(new Error("the host left before sending the saved run")));
        }
      }),
    );
    unsubscribes.push(
      transport.onMessage(message => {
        if (message.t === "resume") {
          finish(() => resolve({ session: message.session, role: message.role ?? "guest" }));
        } else if (message.t === "bye") {
          finish(() =>
            reject(
              message.reason === "wrongAccount"
                ? new CoopWrongAccountError(true)
                : new Error("the host left before sending the saved run"),
            ),
          );
        }
      }),
    );
  });
}

/**
 * Resolve when a partner joins the room: a new client taking the partner's place, or (with an older relay) any pairing.
 * @param acceptCurrent - Resolve at once if a partner is already there
 * @throws If the connection closes first
 */
function waitForPartner(transport: CoopTransport, acceptCurrent: boolean): Promise<void> {
  const joined = (status: string | undefined) => status === "newPeer" || status === "connected";
  if (acceptCurrent && joined(transport.status)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const unsubscribe = transport.onStatusChange(status => {
      if (joined(status)) {
        unsubscribe();
        resolve();
      } else if (status === "closed") {
        unsubscribe();
        reject(new Error("the co-op connection closed while waiting for the partner"));
      }
    });
  });
}

/**
 * The player who stayed in a held room: wait until the partner comes back, run the handshake and, for a run, check it is
 * the partner saved with it and send the wave start save (the caller loads it too, see {@linkcode resumeCoopRun}).
 * Anyone else who joins is sent away, and the room keeps waiting.
 * @throws If the connection closes, or the partner runs another game version
 */
export async function waitForReturningPartner(
  room: HeldCoopRoom,
  local: CoopLocalInfo = getLocalCoopInfo(),
): Promise<CoopConnection> {
  const saved = room.save === null ? null : (JSON.parse(room.save) as Pick<SessionSaveData, "coop">);
  const partnerRole: CoopRole = room.role === "host" ? "guest" : "host";
  for (let first = true; ; first = false) {
    await waitForPartner(room.transport, first);
    let partner: CoopHandshakeResult;
    try {
      partner = await performHandshake(room.transport, { ...local, resume: saved !== null });
    } catch (error) {
      if (error instanceof CoopVersionMismatchError || room.transport.status === "closed") {
        throw error;
      }
      // A client that does not answer (such as the old partner's page, still in the run): send it away.
      room.transport.send({ t: "bye" });
      continue;
    }
    if (saved && !isSavedPartner(saved, partner, partnerRole)) {
      room.transport.send({ t: "bye", reason: "wrongAccount" });
      continue;
    }
    const transport = new ReliableCoopTransport(room.transport);
    if (room.save !== null) {
      transport.send({ t: "resume", session: room.save, role: partnerRole });
    }
    return { role: room.role, transport, ...partner };
  }
}
