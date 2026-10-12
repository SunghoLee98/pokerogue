/**
 * In-process transport pair for tests.
 * @module
 */

import type { CoopMessage } from "#coop/coop-protocol";
import {
  type CoopConnectionStatus,
  type CoopTransport,
  CoopTransportListeners,
  type Unsubscribe,
} from "#coop/coop-transport";

const LOOPBACK_JOIN_CODE = "LOOP00";

class LoopbackTransport implements CoopTransport {
  private readonly listeners = new CoopTransportListeners();
  private peer: LoopbackTransport;

  link(peer: LoopbackTransport): void {
    this.peer = peer;
  }

  host(): Promise<{ joinCode: string }> {
    this.listeners.setStatus("waitingForPeer");
    return Promise.resolve({ joinCode: LOOPBACK_JOIN_CODE });
  }

  join(joinCode: string): Promise<void> {
    if (joinCode !== LOOPBACK_JOIN_CODE || this.peer.listeners.status !== "waitingForPeer") {
      return Promise.reject(new Error("unknown join code"));
    }
    this.listeners.setStatus("connected");
    this.peer.listeners.setStatus("connected");
    return Promise.resolve();
  }

  send(message: CoopMessage): void {
    if (this.isClosed) {
      return;
    }
    // Deliver asynchronously, like a real network would.
    queueMicrotask(() => {
      if (!this.peer.isClosed) {
        this.peer.listeners.emitMessage(message);
      }
    });
  }

  onMessage(handler: (message: CoopMessage) => void): Unsubscribe {
    return this.listeners.onMessage(handler);
  }

  onStatusChange(handler: (status: CoopConnectionStatus) => void): Unsubscribe {
    return this.listeners.onStatusChange(handler);
  }

  close(): void {
    if (this.isClosed) {
      return;
    }
    this.listeners.setStatus("closed");
    this.peer.close();
  }

  private get isClosed(): boolean {
    return this.listeners.status === "closed";
  }
}

/** Create two linked transports. The guest joins with the code the host receives. */
export function createLoopbackPair(): { host: CoopTransport; guest: CoopTransport } {
  const host = new LoopbackTransport();
  const guest = new LoopbackTransport();
  host.link(guest);
  guest.link(host);
  return { host, guest };
}
