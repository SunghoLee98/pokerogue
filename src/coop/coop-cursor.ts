/**
 * Showing each player where the partner's cursor is (spec 4.7), on the starter select screen and the reward screen.
 * Each client sends its cursor whenever it moves to something the partner can see, and draws the partner's as a
 * tinted copy of its own cursor. Cursors change nothing in the run, so they cannot desync.
 * @module
 */

import { globalScene } from "#app/global-scene";
import type { CoopCursorAt, CoopMessage } from "#coop/coop-protocol";
import { type CoopSession, coopSession } from "#coop/coop-session";
import type { Unsubscribe } from "#coop/coop-transport";
import { UiMode } from "#enums/ui-mode";

/** The tint of the partner's cursor, so it is told apart from the player's own. */
export const COOP_PARTNER_CURSOR_TINT = 0x58b8ff;

/** Sends the local cursor, only when it moved. */
export class CoopCursorSender {
  private readonly send: (message: CoopMessage) => void;
  /** The last position sent, as JSON; `null` was sent (or nothing yet) */
  private last = "null";

  constructor(send: (message: CoopMessage) => void) {
    this.send = send;
  }

  /** The local cursor is now here (`null`: on nothing the partner sees). */
  report(at: CoopCursorAt | null): void {
    const key = JSON.stringify(at);
    if (key === this.last) {
      return;
    }
    this.last = key;
    this.send({ t: "cursor", at });
  }
}

/** Make the image showing the partner's cursor: a tinted copy of the local one, drawn just below it. */
export function addCoopPartnerCursor(
  container: Phaser.GameObjects.Container,
  localCursor: Phaser.GameObjects.Image,
): Phaser.GameObjects.Image {
  const cursor = globalScene.add
    .image(0, 0, localCursor.texture.key)
    .setOrigin(localCursor.originX, localCursor.originY)
    .setTint(COOP_PARTNER_CURSOR_TINT)
    .setVisible(false);
  const index = container.getIndex(localCursor);
  container.addAt(cursor, Math.max(index, 0));
  return cursor;
}

// #region Starter select

/** Where the starter select screen shows the partner's cursor, supplied by its handler. */
export interface CoopStarterCursorView {
  /** Show the partner's cursor on this species, `null` to hide it. */
  showPartnerCursor(speciesId: number | null): void;
}

/**
 * Shares the cursor on the starter select screen: sends the species the local cursor is on (`null` when it is not on
 * the grid) and shows the partner's. Players sort and filter the grid on their own, so cursors are shared by species.
 */
export class CoopStarterCursorShare {
  private readonly sender: CoopCursorSender;
  private readonly view: CoopStarterCursorView;
  private readonly unsubscribe: Unsubscribe;
  private partner: number | null = null;

  constructor(
    send: (message: CoopMessage) => void,
    onMessage: (handler: (message: CoopMessage) => void) => Unsubscribe,
    view: CoopStarterCursorView,
  ) {
    this.sender = new CoopCursorSender(send);
    this.view = view;
    this.unsubscribe = onMessage(message => {
      if (message.t !== "cursor") {
        return;
      }
      this.partner = message.at?.screen === "starter" ? message.at.speciesId : null;
      this.view.showPartnerCursor(this.partner);
    });
  }

  /** The partner's cursor species, `null` while not on the grid */
  get partnerSpecies(): number | null {
    return this.partner;
  }

  report(speciesId: number | null): void {
    this.sender.report(speciesId === null ? null : { screen: "starter", speciesId });
  }

  /** Draw the partner's cursor again, after the grid scrolled or was filtered. */
  refresh(): void {
    this.view.showPartnerCursor(this.partner);
  }

  dispose(): void {
    this.report(null);
    this.unsubscribe();
    this.view.showPartnerCursor(null);
  }
}

// #endregion
// #region Reward screen

/** The reward screen's number (`gen`) the cursors refer to, set when a screen opens. */
let rewardGen = -1;
const rewardSenders = new WeakMap<CoopSession, CoopCursorSender>();

/** Where the reward screen shows the partner's cursor, supplied by its handler. */
export interface CoopRewardCursorView {
  /** Show the partner's cursor on this option, `null` to hide it. */
  showPartnerCursor(at: { row: number; cursor: number } | null): void;
}

let rewardView: CoopRewardCursorView | null = null;
let rewardUnsubscribe: Unsubscribe | null = null;
let rewardViewSession: CoopSession | null = null;

/** A co-op reward screen opened: cursors from now on refer to this one. */
export function setCoopRewardCursorGen(gen: number): void {
  rewardGen = gen;
  rewardView?.showPartnerCursor(getPartnerRewardCursor());
}

/** The partner's cursor on the open reward screen, `null` if it is elsewhere. */
function getPartnerRewardCursor(): { row: number; cursor: number } | null {
  const at = coopSession?.inputs.partnerCursor;
  if (at?.screen !== "reward" || at.gen !== rewardGen || globalScene.ui?.mode !== UiMode.MODIFIER_SELECT) {
    return null;
  }
  return { row: at.row, cursor: at.cursor };
}

/**
 * The local cursor moved on the reward screen (`null`: it left the screen). Does nothing outside co-op.
 * Also draws the partner's cursor, since the screen may have just opened.
 */
export function shareCoopRewardCursor(view: CoopRewardCursorView, at: { row: number; cursor: number } | null): void {
  const session = coopSession;
  if (!session) {
    return;
  }
  let sender = rewardSenders.get(session);
  if (!sender) {
    sender = new CoopCursorSender(message => session.inputs.send(message));
    rewardSenders.set(session, sender);
  }
  sender.report(at && { screen: "reward", gen: rewardGen, ...at });
  if (rewardViewSession !== session || rewardView !== view) {
    rewardUnsubscribe?.();
    rewardView = view;
    rewardViewSession = session;
    rewardUnsubscribe = session.inputs.onCursor(() => view.showPartnerCursor(getPartnerRewardCursor()));
  }
  view.showPartnerCursor(at ? getPartnerRewardCursor() : null);
}

// #endregion
