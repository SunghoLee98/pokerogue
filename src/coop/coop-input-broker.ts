/**
 * The co-op input broker: decides nothing itself, but keeps the partner's inputs until the game asks for them.
 *
 * Inputs arrive over the transport whenever the partner makes them, which may be before this client reaches the
 * point that needs them. The broker files them by key and hands them over in arrival order:
 * - turn messages (the partner's battle commands and flee answers) by wave and turn;
 * - decisions both simulations reach in the same order (switch-ins, releases, biomes, moves to forget...)
 *   by sequence number;
 * - answers to the local player's requests by kind and the number the request carried;
 * - picked encounter options in arrival order;
 * - reward screen events, owner requests and pings to whoever listens, keeping those that come early.
 * @module
 */

import type { CoopDecision, CoopDecisionKind, CoopMessage } from "#coop/coop-protocol";
import type { CoopTransport, Unsubscribe } from "#coop/coop-transport";

type ConfirmMessage = Extract<CoopMessage, { t: "confirm" }>;
export type CoopRewardMessage = Extract<CoopMessage, { t: "reward" }>;
export type CoopPingMessage = Extract<CoopMessage, { t: "ping" }>;
export type CoopChoiceMessage = Extract<CoopMessage, { t: "choice" }>;

/** Messages filed under a battle turn. */
export type CoopTurnMessage = Extract<CoopMessage, { t: "turnCommand" }> | (ConfirmMessage & { turn: number });

/** Choices that are decisions: filed by their sequence number. */
const DECISION_KINDS: ReadonlySet<string> = new Set<CoopDecisionKind>([
  "switch",
  "capture",
  "option",
  "partySelect",
  "partyPick",
  "learnMove",
  "evolution",
]);

/** Delivers messages to one listener, keeping those that arrive while nobody listens. */
class Mailbox<M> {
  private readonly early: M[] = [];
  private listener: ((message: M) => void) | null = null;

  deliver(message: M): void {
    if (this.listener) {
      this.listener(message);
    } else {
      this.early.push(message);
    }
  }

  listen(listener: (message: M) => void): Unsubscribe {
    this.listener = listener;
    for (const message of this.early.splice(0)) {
      listener(message);
    }
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
    };
  }
}

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
  private readonly confirms = new Map<string, boolean>();
  private readonly confirmWaiters = new Map<string, (accepted: boolean) => void>();
  private readonly encounterOptions: number[] = [];
  private encounterOptionWaiters: ((index: number) => void)[] = [];
  private readonly rewards = new Mailbox<CoopRewardMessage>();
  private readonly pings = new Mailbox<CoopPingMessage>();
  private readonly choices = new Map<string, Mailbox<CoopChoiceMessage>>();
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

  /** Get the partner's answer to the local request of this kind and number, waiting for it if needed. */
  waitConfirm(kind: ConfirmMessage["kind"], seq: number): Promise<boolean> {
    const key = `${kind}:${seq}`;
    const accepted = this.confirms.get(key);
    if (accepted !== undefined) {
      this.confirms.delete(key);
      return Promise.resolve(accepted);
    }
    return new Promise(resolve => this.confirmWaiters.set(key, resolve));
  }

  /** Get the next encounter option the partner picked, waiting for it if needed. */
  waitEncounterOption(): Promise<number> {
    const index = this.encounterOptions.shift();
    if (index !== undefined) {
      return Promise.resolve(index);
    }
    return new Promise(resolve => this.encounterOptionWaiters.push(resolve));
  }

  /** Receive the reward screen events. Events that came before anyone listened are handed over first. */
  onReward(handler: (message: CoopRewardMessage) => void): Unsubscribe {
    return this.rewards.listen(handler);
  }

  /** Receive the partner's pings, including those that came before anyone listened. */
  onPing(handler: (message: CoopPingMessage) => void): Unsubscribe {
    return this.pings.listen(handler);
  }

  /** Receive non-decision choices of a kind (requests to confirm), including those that came before anyone listened. */
  onChoice(kind: string, handler: (message: CoopChoiceMessage) => void): Unsubscribe {
    return this.choiceMailbox(kind).listen(handler);
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
    this.confirms.clear();
    this.confirmWaiters.clear();
    this.encounterOptionWaiters = [];
  }

  private choiceMailbox(kind: string): Mailbox<CoopChoiceMessage> {
    let mailbox = this.choices.get(kind);
    if (!mailbox) {
      mailbox = new Mailbox();
      this.choices.set(kind, mailbox);
    }
    return mailbox;
  }

  private receive(message: CoopMessage): void {
    switch (message.t) {
      case "turnCommand":
        this.receiveTurnMessage(message);
        break;
      case "confirm":
        if (message.kind === "flee" && message.turn !== undefined) {
          this.receiveTurnMessage({ ...message, turn: message.turn });
        } else if (message.seq !== undefined) {
          this.receiveConfirm(`${message.kind}:${message.seq}`, message.accepted);
        }
        break;
      case "choice":
        if (DECISION_KINDS.has(message.kind) && isDecision(message.payload)) {
          this.receiveDecision(message.payload);
        } else if (message.kind === "meOption") {
          this.receiveEncounterOption((message.payload as { index: number }).index);
        } else {
          this.choiceMailbox(message.kind).deliver(message);
        }
        break;
      case "reward":
        this.rewards.deliver(message);
        break;
      case "ping":
        this.pings.deliver(message);
        break;
    }
  }

  private receiveConfirm(key: string, accepted: boolean): void {
    const waiter = this.confirmWaiters.get(key);
    if (waiter) {
      this.confirmWaiters.delete(key);
      waiter(accepted);
    } else {
      this.confirms.set(key, accepted);
    }
  }

  private receiveEncounterOption(index: number): void {
    const waiter = this.encounterOptionWaiters.shift();
    if (waiter) {
      waiter(index);
    } else {
      this.encounterOptions.push(index);
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
