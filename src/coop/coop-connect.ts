/**
 * Connecting two players: the host gets a join code and waits, the guest joins with it,
 * then both run the version handshake.
 * @module
 */

import { loggedInUser } from "#app/account";
import { globalScene } from "#app/global-scene";
import { type CoopHandshakeResult, type CoopHelloInfo, performHandshake } from "#coop/coop-handshake";
import type { CoopRole } from "#coop/coop-protocol";
import type { CoopTransport, Unsubscribe } from "#coop/coop-transport";
import { getDefaultRelayUrl, parseJoinInput, RelayWebSocketTransport } from "#coop/relay-websocket-transport";
import { ReliableCoopTransport } from "#coop/reliable-coop-transport";
import { version } from "#package.json";

/** A connected, version-checked link to the partner. Its transport resends what a dropped connection loses. */
export interface CoopConnection extends CoopHandshakeResult {
  role: CoopRole;
  transport: CoopTransport;
}

/** What we tell the partner about ourselves in the handshake. */
export type CoopLocalInfo = CoopHelloInfo;

/** The typed join input is not a valid code, or names no relay to connect to. */
export class CoopJoinInputError extends Error {
  constructor(input: string) {
    super(`invalid co-op join input: ${input}`);
    this.name = "CoopJoinInputError";
  }
}

/** Our game version (`package.json`), account name and trainer id. */
export function getLocalCoopInfo(): CoopLocalInfo {
  return {
    gameVersion: version,
    accountName: loggedInUser?.username ?? "Guest",
    trainerId: globalScene?.gameData?.trainerId ?? 0,
  };
}

/** Co-op needs a relay server; without a configured one the co-op menu is hidden. */
export function isCoopAvailable(relayUrl: string | undefined = getDefaultRelayUrl()): boolean {
  return !!relayUrl;
}

/** Resolve once the transport reports `"connected"`, or reject if it closes first. */
function waitForPeer(transport: CoopTransport): { promise: Promise<void>; cancel: Unsubscribe } {
  let unsubscribe: Unsubscribe = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    unsubscribe = transport.onStatusChange(status => {
      if (status === "connected") {
        unsubscribe();
        resolve();
      } else if (status === "closed") {
        unsubscribe();
        reject(new Error("the co-op connection closed before the partner joined"));
      }
    });
  });
  return { promise, cancel: unsubscribe };
}

/**
 * Host a co-op game: obtain a join code, wait for the guest and run the handshake.
 * Close the transport to stop waiting.
 * @param onJoinCode - Called with the code to show to the player
 */
export async function hostCoop(
  transport: CoopTransport,
  onJoinCode: (joinCode: string) => void,
  local: CoopLocalInfo = getLocalCoopInfo(),
): Promise<CoopConnection> {
  // Listen before hosting, so a guest joining right away is not missed.
  const peer = waitForPeer(transport);
  try {
    const { joinCode } = await transport.host();
    onJoinCode(joinCode);
    await peer.promise;
  } finally {
    peer.cancel();
  }
  const partner = await performHandshake(transport, local);
  return { role: "host", transport: new ReliableCoopTransport(transport), ...partner };
}

export interface CoopJoinOptions {
  local?: CoopLocalInfo;
  /** The relay used for a bare code. Default: `VITE_COOP_RELAY_URL` */
  defaultRelayUrl?: string | undefined;
  createTransport?: (relayUrl: string) => CoopTransport;
}

/**
 * Join a co-op game with the code the host shows, optionally prefixed with a local relay address
 * (`192.168.0.10:8787/ABC123`), and run the handshake.
 * @throws {@linkcode CoopJoinInputError} before connecting if the input is not usable
 */
export async function joinCoop(input: string, options: CoopJoinOptions = {}): Promise<CoopConnection> {
  const {
    local = getLocalCoopInfo(),
    defaultRelayUrl = getDefaultRelayUrl(),
    createTransport = (relayUrl: string) => new RelayWebSocketTransport(relayUrl),
  } = options;
  const target = parseJoinInput(input, defaultRelayUrl ?? "");
  if (!target?.relayUrl) {
    throw new CoopJoinInputError(input);
  }
  const transport = createTransport(target.relayUrl);
  try {
    await transport.join(target.code);
  } catch (error) {
    transport.close();
    throw error;
  }
  const partner = await performHandshake(transport, local);
  return { role: "guest", transport: new ReliableCoopTransport(transport), ...partner };
}
