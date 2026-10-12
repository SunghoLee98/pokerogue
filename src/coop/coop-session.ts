/**
 * The single entry point for co-op state.
 * Outside co-op, {@linkcode coopSession} is `null`, so every co-op branch in the game starts with `coopSession?.`.
 * @module
 */

import { CoopOwnership } from "#coop/coop-ownership";
import type { CoopRole } from "#coop/coop-protocol";
import type { CoopTransport } from "#coop/coop-transport";

export class CoopSession {
  readonly localRole: CoopRole;
  readonly transport: CoopTransport;
  readonly ownership: CoopOwnership;

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
}

/** The active co-op session, or `null` outside co-op. */
export let coopSession: CoopSession | null = null;

export function setCoopSession(session: CoopSession | null): void {
  coopSession = session;
}
