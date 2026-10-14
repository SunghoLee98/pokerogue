/**
 * The hello exchange both peers run right after connecting, refusing to play across game versions.
 * @module
 */

import { COOP_PROTOCOL_VERSION } from "#coop/coop-protocol";
import type { CoopTransport, Unsubscribe } from "#coop/coop-transport";

export class CoopVersionMismatchError extends Error {
  readonly localVersion: string;
  readonly peerVersion: string;

  constructor(localVersion: string, peerVersion: string) {
    super(`coop version mismatch: local ${localVersion}, peer ${peerVersion}`);
    this.name = "CoopVersionMismatchError";
    this.localVersion = localVersion;
    this.peerVersion = peerVersion;
  }
}

export class CoopHandshakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoopHandshakeError";
  }
}

/** What a player tells the partner in the handshake. */
export interface CoopHelloInfo {
  /** The `version` from `package.json` */
  gameVersion: string;
  accountName: string;
  /** The account's trainer id, `0` if unknown */
  trainerId?: number;
  /** Set by a host continuing a saved run */
  resume?: boolean;
}

/** What the handshake learned about the partner. */
export interface CoopHandshakeResult {
  peerAccountName: string;
  peerTrainerId: number;
  /** Whether the partner is a host continuing a saved run */
  peerResume: boolean;
}

/**
 * Send our `hello` over a connected transport and wait for the peer's.
 * On a version mismatch, says `bye` and closes the transport.
 * @param local - What we tell the partner
 * @param timeoutMs - How long to wait for the peer's `hello`
 */
export function performHandshake(
  transport: CoopTransport,
  local: CoopHelloInfo,
  timeoutMs = 15_000,
): Promise<CoopHandshakeResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribeMessage: Unsubscribe | undefined;
    let unsubscribeStatus: Unsubscribe | undefined;
    const cleanUp = () => {
      clearTimeout(timer);
      unsubscribeMessage?.();
      unsubscribeStatus?.();
    };
    const finish = (settle: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanUp();
      settle();
    };

    const timer = setTimeout(
      () => finish(() => reject(new CoopHandshakeError("timed out waiting for the peer's hello"))),
      timeoutMs,
    );

    unsubscribeStatus = transport.onStatusChange(status => {
      if (status === "closed") {
        finish(() => reject(new CoopHandshakeError("connection closed during handshake")));
      }
    });

    transport.send({
      t: "hello",
      gameVersion: local.gameVersion,
      protocol: COOP_PROTOCOL_VERSION,
      accountName: local.accountName,
      trainerId: local.trainerId ?? 0,
      ...(local.resume && { resume: true }),
    });

    // Buffered messages are delivered synchronously while subscribing, so the handshake may already be done after this.
    unsubscribeMessage = transport.onMessage(message => {
      if (message.t === "bye") {
        finish(() => reject(new CoopHandshakeError("peer left during handshake")));
        return;
      }
      if (message.t !== "hello") {
        return;
      }
      if (message.gameVersion !== local.gameVersion || message.protocol !== COOP_PROTOCOL_VERSION) {
        finish(() => {
          transport.send({ t: "bye" });
          transport.close();
          reject(new CoopVersionMismatchError(local.gameVersion, message.gameVersion));
        });
        return;
      }
      finish(() =>
        resolve({
          peerAccountName: message.accountName,
          peerTrainerId: message.trainerId ?? 0,
          peerResume: message.resume === true,
        }),
      );
    });
    if (settled) {
      cleanUp();
    }
  });
}
