/**
 * Pings (spec 4.7): while it is the partner's turn to choose, the waiting player can point at a choice.
 * The partner's screen marks it. Pings change nothing in the run, so they cannot desync.
 * @module
 */

import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { showCoopBanner } from "#coop/coop-banner";
import type { CoopPingMessage } from "#coop/coop-input-broker";
import { addCoopPingMarker } from "#coop/coop-ping-marker";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { UiMode } from "#enums/ui-mode";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";

/** The partner's ping on the reward screen */
const MARKER_NAME = "coop-ping";
/** The player's own ping, a short ripple that tells them it was sent */
const SENT_MARKER_NAME = "coop-ping-sent";
/** Half the height of a reward screen item, in the option's own units */
const ITEM_HALF_HEIGHT = 16;

type PingPayload = CoopPingMessage["payload"];

/** Where a list ping (biome, encounter option) is shown: set by the screen that offers the list. */
type ListPingHandler = (index: number) => void;

let listenerSession: CoopSession | null = null;
let listPingHandler: ListPingHandler | null = null;

/** Point the partner at a choice. */
export function sendCoopPing(kind: CoopPingMessage["kind"], payload: PingPayload): void {
  coopSession?.inputs.send({ t: "ping", kind, payload });
  globalScene.ui.playSelect();
  if (kind === "reward") {
    markRewardOption(payload, false);
  }
}

/** Show the partner's pings from now on (once per session). */
export function listenForCoopPings(session: CoopSession): void {
  if (listenerSession === session) {
    return;
  }
  listenerSession = session;
  session.inputs.onPing(message => {
    if (coopSession !== session) {
      return;
    }
    if (message.kind === "reward") {
      markRewardPing(message.payload);
    } else if (message.payload.index !== undefined) {
      listPingHandler?.(message.payload.index);
    }
  });
}

/** Set what a list ping shows; `null` when no list is offered. */
export function setCoopListPingHandler(handler: ListPingHandler | null): void {
  listPingHandler = handler;
}

/** Mark the pinged reward screen option, removing the previous mark. */
function markRewardPing(payload: PingPayload): void {
  if (markRewardOption(payload, true)) {
    audioManager.playSound("se/shing", { volume: 0.6 });
    showCoopBanner(coopText("partnerPinged"), true);
  }
}

/**
 * Put an animated ping marker on a reward screen option: the partner's (a pointing finger and rings, replacing their
 * previous one) or the player's own (rings only).
 * @returns Whether the option is on the screen
 */
function markRewardOption({ row, cursor }: PingPayload, fromPartner: boolean): boolean {
  if (globalScene.ui.mode !== UiMode.MODIFIER_SELECT || row === undefined || cursor === undefined) {
    return false;
  }
  const handler = globalScene.ui.getHandler() as ModifierSelectUiHandler;
  const rows = [handler.options, ...handler.shopOptionsRows.toReversed()];
  const option = rows[row - 1]?.[cursor];
  if (!option) {
    return false;
  }
  const name = fromPartner ? MARKER_NAME : SENT_MARKER_NAME;
  for (const other of rows.flat()) {
    other
      .getAll()
      .filter(o => o.name === name)
      .forEach(o => o.destroy());
  }
  addCoopPingMarker(option, name, {
    x: 0,
    y: 0,
    handOffset: ITEM_HALF_HEIGHT * (option.scaleX || 1) + 2,
    withHand: fromPartner,
  });
  return true;
}
