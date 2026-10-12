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

/**
 * Send our `hello` over a connected transport and wait for the peer's.
 * On a version mismatch, says `bye` and closes the transport.
 * @param local - Our game version (the `version` from `package.json`) and account name
 * @param timeoutMs - How long to wait for the peer's `hello`
 * @returns The peer's account name
 */
export function performHandshake(
  transport: CoopTransport,
  local: { gameVersion: string; accountName: string },
  timeoutMs = 15_000,
): Promise<{ peerAccountName: string }> {
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
      finish(() => resolve({ peerAccountName: message.accountName }));
    });
    if (settled) {
      cleanUp();
    }
  });
}
