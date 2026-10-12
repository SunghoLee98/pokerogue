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
 * - Buffer messages that arrive while no `onMessage` handler is subscribed, and deliver them in order to the next one.
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
 * including the buffering of messages that arrive while nobody listens.
 */
export class CoopTransportListeners {
  private readonly messageHandlers = new Set<(message: CoopMessage) => void>();
  private readonly statusHandlers = new Set<(status: CoopConnectionStatus) => void>();
  private pending: CoopMessage[] = [];
  private currentStatus: CoopConnectionStatus = "connecting";

  get status(): CoopConnectionStatus {
    return this.currentStatus;
  }

  onMessage(handler: (message: CoopMessage) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    const buffered = this.pending;
    this.pending = [];
    for (const message of buffered) {
      handler(message);
    }
    return () => this.messageHandlers.delete(handler);
  }

  onStatusChange(handler: (status: CoopConnectionStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  emitMessage(message: CoopMessage): void {
    if (this.messageHandlers.size === 0) {
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
