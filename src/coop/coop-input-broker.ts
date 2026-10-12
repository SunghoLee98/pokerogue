/**
 * The co-op input broker: decides nothing itself, but keeps the partner's inputs until the game asks for them.
 *
 * Inputs arrive over the transport whenever the partner makes them, which may be before this client reaches the
 * point that needs them. The broker files them by key and hands them over in arrival order:
 * - turn messages (the partner's battle commands and flee answers) by wave and turn;
 * - decisions made while a turn runs (switch-ins, releasing to make room for a catch) by sequence number.
 * @module
 */

import type { CoopDecision, CoopMessage } from "#coop/coop-protocol";
import type { CoopTransport, Unsubscribe } from "#coop/coop-transport";

/** Messages filed under a battle turn. */
export type CoopTurnMessage = Extract<CoopMessage, { t: "turnCommand" }> | Extract<CoopMessage, { t: "confirm" }>;

type TurnMatch = (message: CoopTurnMessage) => boolean;

interface TurnWaiter {
  key: string;
  match: TurnMatch;
  resolve: (message: CoopTurnMessage) => void;
}

function turnKey(wave: number, turn: number): string {
  return `${wave}:${turn}`;
}

function isDecision(payload: unknown): payload is CoopDecision {
  return typeof payload === "object" && payload !== null && typeof (payload as { seq?: unknown }).seq === "number";
}

export class CoopInputBroker {
  private readonly transport: CoopTransport;
  private readonly turnMessages = new Map<string, CoopTurnMessage[]>();
  private turnWaiters: TurnWaiter[] = [];
  private readonly turnListeners = new Set<(message: CoopTurnMessage) => void>();
  private readonly decisions = new Map<number, CoopDecision>();
  private readonly decisionWaiters = new Map<number, (decision: CoopDecision) => void>();
  private readonly unsubscribe: Unsubscribe;

  constructor(transport: CoopTransport) {
    this.transport = transport;
    this.unsubscribe = transport.onMessage(message => this.receive(message));
  }

  send(message: CoopMessage): void {
    this.transport.send(message);
  }

  /** The turn's messages not yet taken, in arrival order. */
  peekTurnMessages(wave: number, turn: number): readonly CoopTurnMessage[] {
    return [...(this.turnMessages.get(turnKey(wave, turn)) ?? [])];
  }

  /** Remove and return the first message of the turn that matches, if any. */
  takeTurnMessage(wave: number, turn: number, match: TurnMatch): CoopTurnMessage | undefined {
    const messages = this.turnMessages.get(turnKey(wave, turn));
    const index = messages?.findIndex(match) ?? -1;
    if (!messages || index === -1) {
      return;
    }
    return messages.splice(index, 1)[0];
  }

  /** Return a taken message to the front of its turn, to be read again. */
  putBackTurnMessage(message: CoopTurnMessage): void {
    const key = turnKey(message.wave, message.turn);
    this.turnMessages.set(key, [message, ...(this.turnMessages.get(key) ?? [])]);
  }

  /** Take the first matching message of the turn, waiting for one to arrive if there is none yet. */
  waitTurnMessage(wave: number, turn: number, match: TurnMatch): Promise<CoopTurnMessage> {
    const message = this.takeTurnMessage(wave, turn, match);
    if (message) {
      return Promise.resolve(message);
    }
    return new Promise(resolve => this.turnWaiters.push({ key: turnKey(wave, turn), match, resolve }));
  }

  /** Get the partner's decision with this sequence number, waiting for it if needed. */
  waitDecision(seq: number): Promise<CoopDecision> {
    const decision = this.decisions.get(seq);
    if (decision) {
      this.decisions.delete(seq);
      return Promise.resolve(decision);
    }
    return new Promise(resolve => this.decisionWaiters.set(seq, resolve));
  }

  /** Be told about every turn message as it arrives, after it was filed or handed to a waiting reader. */
  onTurnMessage(handler: (message: CoopTurnMessage) => void): Unsubscribe {
    this.turnListeners.add(handler);
    return () => this.turnListeners.delete(handler);
  }

  /** Stop listening to the transport. Pending waits never resolve. */
  dispose(): void {
    this.unsubscribe();
    this.turnMessages.clear();
    this.turnWaiters = [];
    this.turnListeners.clear();
    this.decisions.clear();
    this.decisionWaiters.clear();
  }

  private receive(message: CoopMessage): void {
    if (message.t === "turnCommand" || (message.t === "confirm" && message.kind === "flee")) {
      this.receiveTurnMessage(message);
    } else if (message.t === "choice" && isDecision(message.payload)) {
      this.receiveDecision(message.payload);
    }
  }

  private receiveTurnMessage(message: CoopTurnMessage): void {
    const key = turnKey(message.wave, message.turn);
    const waiter = this.turnWaiters.find(w => w.key === key && w.match(message));
    if (waiter) {
      this.turnWaiters = this.turnWaiters.filter(w => w !== waiter);
      waiter.resolve(message);
    } else {
      this.turnMessages.set(key, [...(this.turnMessages.get(key) ?? []), message]);
    }
    // Filed first, so a listener can take the message it is told about.
    for (const listener of [...this.turnListeners]) {
      listener(message);
    }
  }

  private receiveDecision(decision: CoopDecision): void {
    const waiter = this.decisionWaiters.get(decision.seq);
    if (waiter) {
      this.decisionWaiters.delete(decision.seq);
      waiter(decision);
      return;
    }
    this.decisions.set(decision.seq, decision);
  }
}
