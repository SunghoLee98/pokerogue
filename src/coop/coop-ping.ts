/**
 * Pings (spec 4.7): while it is the partner's turn to choose, the waiting player can point at a choice.
 * The partner's screen marks it. Pings change nothing in the run, so they cannot desync.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { showCoopBanner } from "#coop/coop-banner";
import type { CoopPingMessage } from "#coop/coop-input-broker";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { TextStyle } from "#enums/text-style";
import { UiMode } from "#enums/ui-mode";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import { addTextObject } from "#ui/text";

const MARKER_NAME = "coop-ping";

type PingPayload = CoopPingMessage["payload"];

/** Where a list ping (biome, encounter option) is shown: set by the screen that offers the list. */
type ListPingHandler = (index: number) => void;

let listenerSession: CoopSession | null = null;
let listPingHandler: ListPingHandler | null = null;

/** Point the partner at a choice. */
export function sendCoopPing(kind: CoopPingMessage["kind"], payload: PingPayload): void {
  coopSession?.inputs.send({ t: "ping", kind, payload });
  globalScene.ui.playSelect();
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
function markRewardPing({ row, cursor }: PingPayload): void {
  if (globalScene.ui.mode !== UiMode.MODIFIER_SELECT || row === undefined || cursor === undefined) {
    return;
  }
  const handler = globalScene.ui.getHandler() as ModifierSelectUiHandler;
  const rows = [handler.options, ...handler.shopOptionsRows.toReversed()];
  const option = rows[row - 1]?.[cursor];
  if (!option) {
    return;
  }
  for (const other of rows.flat()) {
    other
      .getAll()
      .filter(o => o.name === MARKER_NAME)
      .forEach(o => o.destroy());
  }
  const marker = addTextObject(0, -34, "!", TextStyle.MONEY, { align: "center", fontSize: "96px" }).setOrigin(0.5, 0);
  marker.setName(MARKER_NAME);
  option.add(marker);
  showCoopBanner(coopText("partnerPinged"), true);
}
