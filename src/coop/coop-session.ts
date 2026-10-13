/**
 * The single entry point for co-op state.
 * Outside co-op, {@linkcode coopSession} is `null`, so every co-op branch in the game starts with `coopSession?.`.
 * @module
 */

import { CoopInputBroker } from "#coop/coop-input-broker";
import { CoopOwnership } from "#coop/coop-ownership";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import type { CoopTransport } from "#coop/coop-transport";

/**
 * The session slot a co-op run saves to, apart from the solo slots 0-4 (spec 4.6).
 * Only the host saves there, and only a save server with the co-op slot accepts it.
 */
export const COOP_SESSION_SLOT = 5;

export class CoopSession {
  readonly localRole: CoopRole;
  readonly transport: CoopTransport;
  readonly ownership: CoopOwnership;
  /** The partner's inputs, kept until the game reaches the point that needs them. */
  readonly inputs: CoopInputBroker;
  /** The host's active timed event when the run started (`null` for none). Both clients use it instead of the clock. */
  timedEvent: string | null = null;
  /** Both players' account names, saved with the run (spec 3.8) */
  participants: Record<CoopRole, string> = { host: "", guest: "" };
  private readonly accountSnapshots = new Map<CoopRole, CoopAccountSnapshot>();
  private decisionSeq = 0;

  constructor(localRole: CoopRole, transport: CoopTransport, ownership = new CoopOwnership()) {
    this.localRole = localRole;
    this.transport = transport;
    this.ownership = ownership;
    this.inputs = new CoopInputBroker(transport);
  }

  /**
   * The sequence number of the next choice made while a turn runs (a switch-in, a release to make room).
   * Both simulations reach these choices in the same order, so both count the same numbers.
   */
  nextDecisionSeq(): number {
    return this.decisionSeq++;
  }

  /** The number the next decision will get, saved with the run. */
  get decisionCount(): number {
    return this.decisionSeq;
  }

  /** Continue numbering decisions from a saved run. */
  restoreDecisionCount(count: number): void {
    this.decisionSeq = count;
  }

  get remoteRole(): CoopRole {
    return this.localRole === "host" ? "guest" : "host";
  }

  /** Who picks rewards after a wave: the host on odd waves, the guest on even waves. */
  pickerForWave(waveIndex: number): CoopRole {
    return waveIndex % 2 === 1 ? "host" : "guest";
  }

  isLocalPicker(waveIndex: number): boolean {
    return this.pickerForWave(waveIndex) === this.localRole;
  }

  isLocallyOwned(pokemonId: number): boolean {
    return this.ownership.get(pokemonId) === this.localRole;
  }

  /** Store a player's account snapshot. The simulation reads these instead of the local `gameData`. */
  setAccountSnapshot(role: CoopRole, snapshot: CoopAccountSnapshot): void {
    this.accountSnapshots.set(role, snapshot);
  }

  /**
   * @throws If the snapshot has not been received yet. Falling back to the local `gameData` would hide a desync.
   */
  getAccountSnapshot(role: CoopRole): CoopAccountSnapshot {
    const snapshot = this.accountSnapshots.get(role);
    if (!snapshot) {
      throw new Error(`missing co-op account snapshot for ${role}`);
    }
    return snapshot;
  }
}

/** The active co-op session, or `null` outside co-op. */
export let coopSession: CoopSession | null = null;

/** Replace the active session. The previous session stops listening for the partner's inputs. */
export function setCoopSession(session: CoopSession | null): void {
  if (coopSession && coopSession !== session) {
    coopSession.inputs.dispose();
  }
  coopSession = session;
}

/**
 * The timed event co-op play uses in place of the clock.
 * @returns The event name, `null` for no event, or `undefined` outside co-op (follow the clock)
 */
export function getCoopTimedEvent(): string | null | undefined {
  return coopSession ? coopSession.timedEvent : undefined;
}
