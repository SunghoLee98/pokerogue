/**
 * The "Co-op Play" title menu: host (get a code and wait) or join (type the code), then enter the lobby.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { type CoopConnection, CoopJoinInputError, hostCoop, joinCoop } from "#coop/coop-connect";
import { CoopVersionMismatchError } from "#coop/coop-handshake";
import { openCoopLobby } from "#coop/coop-lobby";
import {
  CoopWrongAccountError,
  hostCoopResume,
  readCoopSave,
  resumeCoopRun,
  waitForCoopResume,
} from "#coop/coop-resume";
import { coopText } from "#coop/coop-text";
import type { CoopTransport } from "#coop/coop-transport";
import { CoopRelayError, getDefaultRelayUrl, RelayWebSocketTransport } from "#coop/relay-websocket-transport";
import { UiMode } from "#enums/ui-mode";
import type { SessionSaveData } from "#types/save-data";
import type { OptionSelectItem } from "#types/ui-types";
import i18next from "i18next";

export interface CoopTitleMenuCallbacks {
  /** Connected and in the lobby; continue to the co-op starter select. The UI is already in message mode. */
  onConnected(): void;
  /** Back to the title screen */
  onCancel(): void;
  /** A saved run was loaded on both clients; continue like after loading a save slot. */
  onResumed(): void;
}

/** Creates the relay connection. Replaced in tests. */
export const coopTransportFactory = {
  createTransport(relayUrl: string): CoopTransport {
    return new RelayWebSocketTransport(relayUrl);
  },
};

/** A message for the player explaining why connecting failed. */
export function describeCoopError(error: unknown): string {
  if (error instanceof CoopWrongAccountError) {
    return coopText(error.turnedAway ? "notTheSavedPartner" : "wrongPartnerJoined");
  }
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
      showCoopTitleMenu(callbacks).catch(error => console.error("co-op menu failed:", error));
      return true;
    },
  };
}

/** Show "Host / Continue / Join / Cancel"; "Continue" only with a saved co-op run (spec 3.8). */
export async function showCoopTitleMenu(callbacks: CoopTitleMenuCallbacks): Promise<void> {
  const saved = await readCoopSave();
  const options: OptionSelectItem[] = [
    {
      label: coopText("hostGame"),
      handler: () => {
        hostGame(callbacks);
        return true;
      },
    },
    ...(saved
      ? [
          {
            label: coopText("continueGame"),
            handler: () => {
              continueGame(saved, callbacks);
              return true;
            },
          },
        ]
      : []),
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

/** Load the saved run on this client and continue from the title screen. */
async function resume(connection: CoopConnection, json: string, callbacks: CoopTitleMenuCallbacks): Promise<void> {
  globalScene.ui.setMode(UiMode.MESSAGE);
  globalScene.ui.resetModeChain();
  await resumeCoopRun(connection.role, connection.transport, json);
  globalScene.ui.clearText();
  callbacks.onResumed();
}

/** Show a join code with a cancel button while waiting for the partner. */
function showJoinCode(code: string, cancel: () => void): void {
  const { ui } = globalScene;
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
}

/** Host the saved run: a join code, the saved partner joins, both load the save. */
function continueGame(saved: SessionSaveData, callbacks: CoopTitleMenuCallbacks): void {
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
  hostCoopResume(transport, saved, code => {
    if (!cancelled) {
      showJoinCode(code, cancel);
    }
  })
    .then(({ connection, json }) => (cancelled ? undefined : resume(connection, json, callbacks)))
    .catch(error => {
      if (!cancelled) {
        transport.close();
        showFailure(error, callbacks);
      }
    });
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
    if (!cancelled) {
      showJoinCode(code, cancel);
    }
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
          .then(async connection => {
            if (!connection.peerResume) {
              enterLobby(connection, callbacks);
              return;
            }
            // The host continues a saved run: no lobby, wait for the save.
            ui.showText(coopText("loadingSavedRun"));
            try {
              await resume(connection, await waitForCoopResume(connection.transport), callbacks);
            } catch (error) {
              connection.transport.close();
              throw error;
            }
          })
          .catch(error => showFailure(error, callbacks));
      },
      () => callbacks.onCancel(),
    ],
  });
}
