/**
 * The single entry point for co-op state.
 * Outside co-op, {@linkcode coopSession} is `null`, so every co-op branch in the game starts with `coopSession?.`.
 * @module
 */

import { CoopOwnership } from "#coop/coop-ownership";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import type { CoopTransport } from "#coop/coop-transport";

export class CoopSession {
  readonly localRole: CoopRole;
  readonly transport: CoopTransport;
  readonly ownership: CoopOwnership;
  /** The host's active timed event when the run started (`null` for none). Both clients use it instead of the clock. */
  timedEvent: string | null = null;
  private readonly accountSnapshots = new Map<CoopRole, CoopAccountSnapshot>();

  constructor(localRole: CoopRole, transport: CoopTransport, ownership = new CoopOwnership()) {
    this.localRole = localRole;
    this.transport = transport;
    this.ownership = ownership;
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

export function setCoopSession(session: CoopSession | null): void {
  coopSession = session;
}

/**
 * The timed event co-op play uses in place of the clock.
 * @returns The event name, `null` for no event, or `undefined` outside co-op (follow the clock)
 */
export function getCoopTimedEvent(): string | null | undefined {
  return coopSession ? coopSession.timedEvent : undefined;
}
