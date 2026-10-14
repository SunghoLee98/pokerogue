/**
 * Comparing the two clients' state during the run (spec 4.1 "desync 감지").
 *
 * At the end of every turn and the start of every wave, each client hashes its state, keeps the hash and sends it.
 * The hashes of both clients are compared in order; at the first difference the run is saved and stopped
 * (resynchronizing from the host's state is future work). Hashing reads the state only, so it cannot cause a desync.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { type CoopChecksum, findFirstDesync } from "#coop/coop-desync";
import { endCoopRun } from "#coop/coop-exit";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { computeCoopStateHash } from "#coop/coop-state-hash";

interface ChecksumState {
  /** Hashes not compared yet, oldest first */
  local: CoopChecksum[];
  remote: CoopChecksum[];
}

const states = new WeakMap<CoopSession, ChecksumState>();

/** Compare the hashes both clients have made so far, dropping those that agree. */
function compare(session: CoopSession, state: ChecksumState): void {
  const count = Math.min(state.local.length, state.remote.length);
  const desync = findFirstDesync(state.local.slice(0, count), state.remote.slice(0, count));
  if (desync) {
    console.error("co-op desync: the partner's state differs", {
      role: session.localRole,
      local: desync.expected,
      partner: desync.actual,
    });
    endCoopRun("desyncDetected", "desync");
    return;
  }
  state.local.splice(0, count);
  state.remote.splice(0, count);
}

/** Start comparing hashes with the partner. Called when a session opens. */
export function attachCoopChecksums(session: CoopSession): void {
  const state: ChecksumState = { local: [], remote: [] };
  states.set(session, state);
  session.transport.onMessage(message => {
    if (message.t === "checksum" && coopSession === session) {
      state.remote.push({ wave: message.wave, turn: message.turn, hash: message.hash });
      compare(session, state);
    }
  });
}

/**
 * A checkpoint (end of turn, start of wave): hash the state, send it and compare. Does nothing outside co-op.
 */
export function recordCoopChecksum(): void {
  const session = coopSession;
  const state = session && states.get(session);
  if (!session || !state) {
    return;
  }
  const { waveIndex: wave, turn } = globalScene.currentBattle;
  const checksum: CoopChecksum = { wave, turn, hash: computeCoopStateHash() };
  state.local.push(checksum);
  session.inputs.send({ t: "checksum", ...checksum });
  compare(session, state);
}
