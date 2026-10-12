/**
 * The "Co-op Play" title menu: host (get a code and wait) or join (type the code), then enter the lobby.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { type CoopConnection, CoopJoinInputError, hostCoop, joinCoop } from "#coop/coop-connect";
import { CoopVersionMismatchError } from "#coop/coop-handshake";
import { openCoopLobby } from "#coop/coop-lobby";
import { coopText } from "#coop/coop-text";
import type { CoopTransport } from "#coop/coop-transport";
import { CoopRelayError, getDefaultRelayUrl, RelayWebSocketTransport } from "#coop/relay-websocket-transport";
import { UiMode } from "#enums/ui-mode";
import type { OptionSelectItem } from "#types/ui-types";
import i18next from "i18next";

export interface CoopTitleMenuCallbacks {
  /** Connected and in the lobby; continue to the co-op starter select. The UI is already in message mode. */
  onConnected(): void;
  /** Back to the title screen */
  onCancel(): void;
}

/** Creates the relay connection. Replaced in tests. */
export const coopTransportFactory = {
  createTransport(relayUrl: string): CoopTransport {
    return new RelayWebSocketTransport(relayUrl);
  },
};

/** A message for the player explaining why connecting failed. */
export function describeCoopError(error: unknown): string {
  if (error instanceof CoopJoinInputError) {
    return coopText("invalidCode");
  }
  if (error instanceof CoopRelayError) {
    switch (error.reason) {
      case "notFound":
        return coopText("codeNotFound");
      case "full":
        return coopText("roomFull");
      case "badRequest":
        return coopText("invalidCode");
    }
  }
  if (error instanceof CoopVersionMismatchError) {
    return coopText("versionMismatch", { local: error.localVersion, peer: error.peerVersion });
  }
  return coopText("connectionFailed");
}

/** The title screen entry that opens the co-op menu. */
export function createCoopTitleOption(callbacks: CoopTitleMenuCallbacks): OptionSelectItem {
  return {
    label: coopText("coopPlay"),
    handler: () => {
      showCoopTitleMenu(callbacks);
      return true;
    },
  };
}

/** Show "Host / Join / Cancel". */
export function showCoopTitleMenu(callbacks: CoopTitleMenuCallbacks): void {
  const options: OptionSelectItem[] = [
    {
      label: coopText("hostGame"),
      handler: () => {
        hostGame(callbacks);
        return true;
      },
    },
    {
      label: coopText("joinGame"),
      handler: () => {
        showJoinForm(callbacks);
        return true;
      },
    },
    {
      label: i18next.t("menu:cancel"),
      handler: () => {
        callbacks.onCancel();
        return true;
      },
    },
  ];
  globalScene.ui.setOverlayMode(UiMode.OPTION_SELECT, { options, yOffset: 48 });
}

function enterLobby(connection: CoopConnection, callbacks: CoopTitleMenuCallbacks): void {
  openCoopLobby(connection);
  globalScene.ui.setMode(UiMode.MESSAGE);
  globalScene.ui.clearText();
  callbacks.onConnected();
}

function showFailure(error: unknown, callbacks: CoopTitleMenuCallbacks): void {
  console.error("co-op connection failed:", error);
  globalScene.ui.setMode(UiMode.MESSAGE);
  globalScene.ui.showText(describeCoopError(error), null, () => callbacks.onCancel(), null, true);
}

/** Get a join code, show it with a cancel button, and enter the lobby once the guest joins. */
function hostGame(callbacks: CoopTitleMenuCallbacks): void {
  const { ui } = globalScene;
  const transport = coopTransportFactory.createTransport(getDefaultRelayUrl() ?? "");
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    transport.close();
    callbacks.onCancel();
  };

  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("gettingJoinCode"));
  hostCoop(transport, code => {
    if (cancelled) {
      return;
    }
    ui.showText(coopText("waitingForPartner", { code }), null, () => {
      const options: OptionSelectItem[] = [
        {
          label: i18next.t("menu:cancel"),
          handler: () => {
            cancel();
            return true;
          },
        },
      ];
      ui.setOverlayMode(UiMode.OPTION_SELECT, { options, yOffset: 48 });
    });
  })
    .then(connection => {
      if (!cancelled) {
        enterLobby(connection, callbacks);
      }
    })
    .catch(error => {
      if (!cancelled) {
        transport.close();
        showFailure(error, callbacks);
      }
    });
}

/** Ask for the join code, connect and enter the lobby. */
function showJoinForm(callbacks: CoopTitleMenuCallbacks): void {
  const { ui } = globalScene;
  ui.setOverlayMode(UiMode.COOP_JOIN_FORM, {
    buttonActions: [
      (input: string) => {
        ui.setMode(UiMode.MESSAGE);
        ui.showText(coopText("connecting"));
        joinCoop(input, { createTransport: url => coopTransportFactory.createTransport(url) })
          .then(connection => enterLobby(connection, callbacks))
          .catch(error => showFailure(error, callbacks));
      },
      () => callbacks.onCancel(),
    ],
  });
}
