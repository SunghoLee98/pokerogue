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

export class LoopbackTransport implements CoopTransport {
  private readonly listeners = new CoopTransportListeners();
  private peer: LoopbackTransport;
  /** While dropped, messages are lost as over a broken connection. */
  private dropped = false;
  /** Unset unless a test sets it, as a relay room's code */
  joinCode: string | null = null;

  get status(): CoopConnectionStatus {
    return this.listeners.status;
  }

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
    if (this.isClosed || this.dropped) {
      return;
    }
    // Deliver asynchronously, like a real network would.
    queueMicrotask(() => {
      if (!this.peer.isClosed && !this.peer.dropped) {
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
    // Queued behind messages already sent, so the peer sees them before the close, as over a real connection.
    queueMicrotask(() => this.peer.listeners.setStatus("closed"));
  }

  /** Test control: lose the connection (both ends report `"reconnecting"`). */
  setDropped(dropped: boolean): void {
    if (this.isClosed) {
      return;
    }
    this.dropped = dropped;
    this.listeners.setStatus(dropped ? "reconnecting" : "connected");
  }

  /** Test control: a new client takes the partner's place, as a reloaded page joining the relay room again. */
  acceptNewPeer(peer: LoopbackTransport): void {
    // The old partner's client is gone: what it still sends is lost.
    this.peer.listeners.setStatus("closed");
    this.link(peer);
    peer.link(this);
    this.dropped = false;
    peer.listeners.setStatus("connected");
    this.listeners.setStatus("newPeer");
  }

  /** Test control: the partner's client is gone; this end waits for another one. */
  losePeer(): void {
    this.listeners.setStatus("reconnecting");
  }

  private get isClosed(): boolean {
    return this.listeners.status === "closed";
  }
}

export interface LoopbackPair {
  host: LoopbackTransport;
  guest: LoopbackTransport;
  /** Break the connection: both ends report `"reconnecting"` and messages are lost until {@linkcode restore}. */
  drop(): void;
  /** Reconnect both ends. */
  restore(): void;
}

/** Create two linked transports. The guest joins with the code the host receives. */
export function createLoopbackPair(): LoopbackPair {
  const host = new LoopbackTransport();
  const guest = new LoopbackTransport();
  host.link(guest);
  guest.link(host);
  return {
    host,
    guest,
    drop: () => {
      host.setDropped(true);
      guest.setDropped(true);
    },
    restore: () => {
      host.setDropped(false);
      guest.setDropped(false);
    },
  };
}
