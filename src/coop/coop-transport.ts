/**
 * Transport abstraction for co-op play. Game logic only talks to {@linkcode CoopTransport}
 * and never knows whether messages go through a relay server or stay in-process.
 * @module
 */

import type { CoopMessage } from "#coop/coop-protocol";

export type Unsubscribe = () => void;

export type CoopConnectionStatus = "connecting" | "waitingForPeer" | "connected" | "reconnecting" | "closed";

/**
 * A two-party connection.
 *
 * Every implementation must:
 * - Buffer messages that arrive before the first `onMessage` handler subscribes, and deliver them in order on subscribe.
 * - Silently ignore `send` after `close()`.
 */
export interface CoopTransport {
  /** Host: obtain a join code for the guest. */
  host(): Promise<{ joinCode: string }>;
  /** Guest: connect using the host's join code. */
  join(joinCode: string): Promise<void>;
  send(message: CoopMessage): void;
  onMessage(handler: (message: CoopMessage) => void): Unsubscribe;
  onStatusChange(handler: (status: CoopConnectionStatus) => void): Unsubscribe;
  close(): void;
}

/**
 * Handler bookkeeping shared by transport implementations,
 * including the buffering of messages that arrive before anyone listens.
 */
export class CoopTransportListeners {
  private readonly messageHandlers = new Set<(message: CoopMessage) => void>();
  private readonly statusHandlers = new Set<(status: CoopConnectionStatus) => void>();
  private pending: CoopMessage[] | null = [];
  private currentStatus: CoopConnectionStatus = "connecting";

  get status(): CoopConnectionStatus {
    return this.currentStatus;
  }

  onMessage(handler: (message: CoopMessage) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    if (this.pending) {
      const buffered = this.pending;
      this.pending = null;
      for (const message of buffered) {
        handler(message);
      }
    }
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (status: CoopConnectionStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  emitMessage(message: CoopMessage): void {
    if (this.pending) {
      this.pending.push(message);
      return;
    }
    for (const handler of [...this.messageHandlers]) {
      handler(message);
    }
  }

  /** Change the status, notifying handlers only if it actually changed. */
  setStatus(status: CoopConnectionStatus): void {
    if (status === this.currentStatus) {
      return;
    }
    this.currentStatus = status;
    for (const handler of [...this.statusHandlers]) {
      handler(status);
    }
  }
}
