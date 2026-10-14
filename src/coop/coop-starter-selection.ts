/**
 * The co-op starter selection handshake.
 *
 * Each player picks on their own screen. The pokemon a player puts in their party are shared as they change
 * (the cursor is not), and pressing start makes the player ready with them. A ready player may take it back while
 * the partner is still picking.
 * Both players share one starter point budget: a player's party takes its cost out of it, so the other player picks
 * with what is left. If both become ready at once and their parties cost more than the budget together,
 * the guest gives way: its ready is taken back and it picks again.
 * When both are ready the host decides the run: it sends `start` with the shared seed, both account snapshots,
 * both players' picks and its active timed event, and both clients start from that one message.
 * @module
 */

import { timedEventManager } from "#app/global-event-manager";
import { COOP_MAX_OWNED } from "#coop/coop-ownership";
import type { CoopAccountSnapshot, CoopMessage, CoopRole, CoopStarterPayload } from "#coop/coop-protocol";
import type { CoopTransport, Unsubscribe } from "#coop/coop-transport";
import { randomString } from "#utils/common";

/** Everything both clients need to create the same co-op run. */
export interface CoopStartInfo {
  seed: string;
  accounts: Record<CoopRole, CoopAccountSnapshot>;
  picks: Record<CoopRole, CoopStarterPayload[]>;
  /** The name of the host's active timed event, or `null` for none */
  timedEvent: string | null;
}

export interface CoopPartnerSelection {
  /** The pokemon in the partner's party, confirmed once they are ready */
  readonly picks: readonly CoopStarterPayload[];
  readonly ready: boolean;
  /** The starter points the partner's party takes from the shared budget */
  readonly cost: number;
}

/** The starter points of a party: what the picks cost and the budget both players share. */
export interface CoopStarterPoints {
  /** What the picks cost on the picking player's account */
  cost: number;
  /** Both players' shared starter point budget */
  limit: number;
}

export interface CoopStarterSelectionOptions {
  /** The local account snapshot, captured whenever the local player becomes ready */
  getAccount(): CoopAccountSnapshot;
  /** The shared seed (host only). Default: a random 24 character string, like a solo run */
  createSeed?(): string;
  /** The active timed event (host only). Default: the timed event manager's active event */
  getTimedEvent?(): string | null;
}

type StartersMessage = Extract<CoopMessage, { t: "starters" }>;

export class CoopStarterSelection {
  readonly role: CoopRole;
  private readonly transport: CoopTransport;
  private readonly options: CoopStarterSelectionOptions;
  private readonly changeHandlers = new Set<() => void>();
  private readonly startHandlers = new Set<(info: CoopStartInfo) => void>();
  private readonly unsubscribes: Unsubscribe[];

  private localPicks: CoopStarterPayload[] = [];
  private localPoints: CoopStarterPoints = { cost: 0, limit: 0 };
  private localAccount: CoopAccountSnapshot | null = null;
  private ready = false;
  private partnerPicks: CoopStarterPayload[] = [];
  private partnerReady = false;
  private partnerCost = 0;
  /** Whether the guest's last ready was taken back because both readied over the shared budget */
  private yielded = false;
  private partnerAccount: CoopAccountSnapshot | null = null;
  private started: CoopStartInfo | null = null;
  private isClosed = false;

  constructor(role: CoopRole, transport: CoopTransport, options: CoopStarterSelectionOptions) {
    this.role = role;
    this.transport = transport;
    this.options = options;
    this.unsubscribes = [
      transport.onMessage(message => this.handleMessage(message)),
      transport.onStatusChange(status => {
        if (status === "closed") {
          this.close();
        }
      }),
    ];
  }

  get localReady(): boolean {
    return this.ready;
  }

  get partner(): CoopPartnerSelection {
    return { picks: this.partnerPicks, ready: this.partnerReady, cost: this.partnerCost };
  }

  /** Whether the local ready was taken back because the partner readied at the same time and took the points */
  get readyYielded(): boolean {
    return this.yielded;
  }

  /** The run both players agreed on, once started */
  get startInfo(): CoopStartInfo | null {
    return this.started;
  }

  /** Whether the partner left; a closed selection can no longer start */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Share the pokemon now in the local party, before ready.
   * Ignored while ready (the party cannot change then) or once the selection has started or closed.
   * @param points - What the picks cost and the shared budget
   */
  setPicks(picks: CoopStarterPayload[], points: CoopStarterPoints): void {
    if (this.ready || this.started || this.isClosed) {
      return;
    }
    this.localPicks = [...picks];
    this.localPoints = { ...points };
    this.sendSelection();
  }

  /**
   * Confirm the local picks and become ready.
   * @param points - What the picks cost and the shared budget
   * @throws If there are no picks or more than {@linkcode COOP_MAX_OWNED}, if the picks cost more than the partner
   * left of the budget, or if the selection has started or closed
   */
  setReady(picks: CoopStarterPayload[], points: CoopStarterPoints): void {
    if (picks.length === 0 || picks.length > COOP_MAX_OWNED) {
      throw new Error(`a co-op player picks 1 to ${COOP_MAX_OWNED} starters, not ${picks.length}`);
    }
    if (points.cost > points.limit - this.partnerCost) {
      throw new Error(`the picks cost ${points.cost} but only ${points.limit - this.partnerCost} points are left`);
    }
    if (this.started || this.isClosed) {
      throw new Error("the co-op starter selection is over");
    }
    this.localPicks = [...picks];
    this.localPoints = { ...points };
    this.yielded = false;
    this.localAccount = this.options.getAccount();
    this.ready = true;
    this.sendSelection();
    this.tryStart();
  }

  /**
   * Take back the ready state to pick again. The picks stay shared as the party the player keeps picking from.
   * @returns `false` if the run has already started (the host's start wins)
   */
  cancelReady(): boolean {
    if (this.started) {
      return false;
    }
    this.yielded = false;
    this.unready();
    return true;
  }

  onChange(handler: () => void): Unsubscribe {
    this.changeHandlers.add(handler);
    return () => this.changeHandlers.delete(handler);
  }

  onStart(handler: (info: CoopStartInfo) => void): Unsubscribe {
    this.startHandlers.add(handler);
    return () => this.startHandlers.delete(handler);
  }

  /** Stop listening to the transport. The transport itself stays open. */
  dispose(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.changeHandlers.clear();
    this.startHandlers.clear();
  }

  private unready(): void {
    if (this.ready) {
      this.ready = false;
      this.sendSelection();
    }
  }

  /** Whether both players are ready with picks that cost more than the shared budget together. */
  private overBudget(): boolean {
    return this.ready && this.partnerReady && this.localPoints.cost + this.partnerCost > this.localPoints.limit;
  }

  private sendSelection(): void {
    this.transport.send({
      t: "starters",
      picks: this.localPicks,
      ready: this.ready,
      cost: this.localPoints.cost,
      account: this.localAccount ?? this.options.getAccount(),
    });
  }

  private handleMessage(message: CoopMessage): void {
    if (this.started) {
      return;
    }
    switch (message.t) {
      case "starters":
        this.handlePartnerSelection(message);
        break;
      case "start":
        if (this.role === "guest") {
          this.begin({
            seed: message.seed,
            accounts: { host: message.hostWorldData, guest: message.guestAccount },
            picks: { host: message.hostPicks, guest: message.guestPicks },
            timedEvent: message.timedEvent,
          });
        }
        break;
      case "bye":
        this.close();
        break;
    }
  }

  private handlePartnerSelection(message: StartersMessage): void {
    this.partnerReady = message.ready;
    this.partnerPicks = message.picks;
    this.partnerCost = message.cost;
    this.partnerAccount = message.account;
    // Both readied at once over the budget: the host's ready stands, the guest picks again with what is left.
    if (this.role === "guest" && this.overBudget()) {
      this.yielded = true;
      this.unready();
    }
    this.emitChange();
    this.tryStart();
  }

  /**
   * The host starts the run as soon as both players are ready, unless their picks cost more than the shared budget
   * together; then it waits for the guest to give way.
   */
  private tryStart(): void {
    if (this.role !== "host" || !this.ready || !this.partnerReady || !this.localAccount || !this.partnerAccount) {
      return;
    }
    if (this.overBudget()) {
      return;
    }
    const info: CoopStartInfo = {
      seed: this.options.createSeed?.() ?? randomString(24),
      accounts: { host: this.localAccount, guest: this.partnerAccount },
      picks: { host: this.localPicks, guest: this.partnerPicks },
      timedEvent: this.options.getTimedEvent
        ? this.options.getTimedEvent()
        : (timedEventManager.activeEvent()?.name ?? null),
    };
    this.transport.send({
      t: "start",
      seed: info.seed,
      hostWorldData: info.accounts.host,
      guestAccount: info.accounts.guest,
      hostPicks: info.picks.host,
      guestPicks: info.picks.guest,
      timedEvent: info.timedEvent,
    });
    this.begin(info);
  }

  private begin(info: CoopStartInfo): void {
    this.started = info;
    this.emitChange();
    for (const handler of [...this.startHandlers]) {
      handler(info);
    }
  }

  private close(): void {
    if (this.isClosed || this.started) {
      return;
    }
    this.isClosed = true;
    this.emitChange();
  }

  private emitChange(): void {
    for (const handler of [...this.changeHandlers]) {
      handler();
    }
  }
}
