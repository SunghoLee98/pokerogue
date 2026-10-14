/**
 * Resending what a dropped connection lost (spec 3.8 "끊김").
 *
 * The relay drops messages sent while either player is disconnected. Lockstep play only needs every input to arrive
 * once and in order, so this layer numbers the messages, keeps them until the partner confirms them, and resends
 * the unconfirmed ones whenever the connection comes back. Both clients wrap their connection right after the
 * handshake; the game above never sees the numbers.
 * @module
 */

import type { CoopMessage } from "#coop/coop-protocol";
import {
  type CoopConnectionStatus,
  type CoopTransport,
  CoopTransportListeners,
  type Unsubscribe,
} from "#coop/coop-transport";

/** Confirm received messages after this many, so the sender can forget them. */
const ACK_EVERY = 16;

export class ReliableCoopTransport implements CoopTransport {
  private readonly inner: CoopTransport;
  private readonly listeners = new CoopTransportListeners();
  private nextOut = 1;
  /** Sent messages the partner has not confirmed, in order */
  private outbox: CoopMessage[] = [];
  /** The number of the last message handed to the game */
  private lastIn = 0;
  /** Messages that arrived ahead of a missing one, by number */
  private readonly ahead = new Map<number, CoopMessage>();
  private sinceAck = 0;
  private interrupted = false;
  private released = false;
  private readonly unsubscribes: Unsubscribe[];

  /** @param inner - A connected transport, after the handshake */
  constructor(inner: CoopTransport) {
    this.inner = inner;
    this.listeners.setStatus("connected");
    this.unsubscribes = [
      inner.onMessage(message => this.receive(message)),
      inner.onStatusChange(status => this.changeStatus(status)),
    ];
  }

  get joinCode(): string | null {
    return this.inner.joinCode ?? null;
  }

  /**
   * Hand the connection over for a new partner, whose message numbers start over.
   * From now on this wrapper neither sends nor closes, and its listeners hear nothing more.
   * @returns The connection underneath
   */
  release(): CoopTransport {
    this.released = true;
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    return this.inner;
  }

  get status(): CoopConnectionStatus {
    return this.listeners.status;
  }

  host(): Promise<{ joinCode: string }> {
    return this.inner.host();
  }

  join(joinCode: string): Promise<void> {
    return this.inner.join(joinCode);
  }

  /** Number the message and send it; it is kept until confirmed, so a send while disconnected is not lost. */
  send(message: CoopMessage): void {
    if (this.released) {
      return;
    }
    const numbered = { ...message, n: this.nextOut++ };
    this.outbox.push(numbered);
    this.inner.send(numbered);
  }

  onMessage(handler: (message: CoopMessage) => void): Unsubscribe {
    return this.listeners.onMessage(handler);
  }

  onStatusChange(handler: (status: CoopConnectionStatus) => void): Unsubscribe {
    return this.listeners.onStatusChange(handler);
  }

  close(): void {
    if (!this.released) {
      this.inner.close();
    }
  }

  private changeStatus(status: CoopConnectionStatus): void {
    if (status === "reconnecting") {
      this.interrupted = true;
    } else if (status === "connected" && this.interrupted) {
      this.interrupted = false;
      // Tell the partner what arrived, then send everything it has not confirmed; it drops what it already has.
      this.inner.send({ t: "ack", n: this.lastIn });
      for (const message of this.outbox) {
        this.inner.send(message);
      }
    }
    this.listeners.setStatus(status);
  }

  private receive(message: CoopMessage): void {
    if (message.t === "ack") {
      this.outbox = this.outbox.filter(m => (m.n ?? 0) > message.n);
      return;
    }
    const { n } = message;
    if (n === undefined) {
      this.listeners.emitMessage(message);
      return;
    }
    if (n <= this.lastIn) {
      return;
    }
    this.ahead.set(n, message);
    for (let next = this.ahead.get(this.lastIn + 1); next; next = this.ahead.get(this.lastIn + 1)) {
      this.ahead.delete(this.lastIn + 1);
      this.lastIn++;
      const { n: _, ...body } = next;
      this.listeners.emitMessage(body as CoopMessage);
      this.confirm();
    }
  }

  private confirm(): void {
    if (++this.sinceAck >= ACK_EVERY) {
      this.sinceAck = 0;
      this.inner.send({ t: "ack", n: this.lastIn });
    }
  }
}
