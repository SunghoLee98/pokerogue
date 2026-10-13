/**
 * Leaving a co-op run, whatever the cause (spec 3.8): the partner's connection dropped for good, the partner left,
 * a player chose "save and quit", or the two games went out of sync.
 *
 * Every cause ends the same way: the reason is shown, the host keeps the save made at the start of the current wave
 * (uploading it like solo "save and quit"), the guest saves no session, and both go back to the title screen.
 * While the connection is down, the game waits up to a minute for the partner before ending.
 * @module
 */

import { getSessionDataLocalStorageKey } from "#app/account";
import { globalScene } from "#app/global-scene";
import { hideCoopBanner, showCoopBanner } from "#coop/coop-banner";
import type { CoopByeReason } from "#coop/coop-protocol";
import { COOP_SESSION_SLOT, type CoopSession, coopSession } from "#coop/coop-session";
import { type CoopTextKey, coopText } from "#coop/coop-text";
import type { CoopTransport } from "#coop/coop-transport";

/** How co-op leaves a run. Replaced in tests. */
export const coopExit = {
  /** Go back to the title screen, as solo "save and quit" does */
  returnToTitle: (): void => globalScene.reset(true),
  /** How long the reason stays on screen before leaving */
  noticeMs: 2500,
  /** How long to wait for a dropped partner (the relay keeps the slot as long) */
  reconnectWindowMs: 60_000,
};

/** Why a co-op run ends; each has its own text. */
export type CoopEndReason =
  | "connectionLost"
  | "partnerLeftRun"
  | "partnerSavedAndQuit"
  | "savingAndQuitting"
  | "desyncDetected";

const BYE_REASONS: Partial<Record<CoopByeReason, CoopEndReason>> = {
  saveAndQuit: "partnerSavedAndQuit",
  desync: "desyncDetected",
};

/** Transports whose run is ending, so that one ending does not start another. */
const ending = new WeakSet<CoopTransport>();

/** How to reach the lobby (`coop-lobby.ts` registers it). */
let lobbyExit: { transport(): CoopTransport | null; leave(): void } = {
  transport: () => null,
  leave: () => {},
};

/** Called by the lobby module: where its connection is, and how to leave co-op. */
export function registerCoopLobbyExit(exit: typeof lobbyExit): void {
  lobbyExit = exit;
}

/** The co-op connection in use: the running session's or the lobby's. */
function currentTransport(): CoopTransport | null {
  return coopSession?.transport ?? lobbyExit.transport();
}

/**
 * Watch a co-op connection for the rest of its life: show the reconnect countdown while it is down, and end the run
 * if the partner does not come back in time, the connection closes or the partner says goodbye.
 * Events for a connection that is no longer the current one (after leaving co-op) are ignored.
 */
export function watchCoopConnection(transport: CoopTransport): void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopCountdown = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const isCurrent = () => currentTransport() === transport && !ending.has(transport);

  transport.onStatusChange(status => {
    if (!isCurrent()) {
      stopCountdown();
      return;
    }
    if (status === "reconnecting" && timer === null) {
      const deadline = Date.now() + coopExit.reconnectWindowMs;
      const show = () => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        showCoopBanner(coopText("partnerReconnecting", { seconds: left }));
      };
      show();
      timer = setInterval(
        () => {
          if (!isCurrent()) {
            stopCountdown();
          } else if (Date.now() >= deadline) {
            stopCountdown();
            endCoopRun("connectionLost");
          } else {
            show();
          }
        },
        Math.min(1000, coopExit.reconnectWindowMs / 4),
      );
    } else if (status === "connected" && timer !== null) {
      stopCountdown();
      hideCoopBanner();
    } else if (status === "closed") {
      stopCountdown();
      endCoopRun("connectionLost");
    }
  });

  transport.onMessage(message => {
    if (message.t === "bye" && isCurrent()) {
      stopCountdown();
      endCoopRun((message.reason && BYE_REASONS[message.reason]) || "partnerLeftRun");
    }
  });
}

/** The host keeps the save made at the start of the current wave, uploaded like solo "save and quit" does. */
async function saveWaveStart(session: CoopSession | null): Promise<void> {
  if (session?.localRole !== "host" || !localStorage.getItem(getSessionDataLocalStorageKey(COOP_SESSION_SLOT))) {
    return;
  }
  try {
    await globalScene.gameData.saveAll(true, true, true, true);
  } catch (error) {
    console.error("co-op: could not save the run before leaving:", error);
  }
}

/**
 * End the co-op run (or leave the lobby) and go back to the title screen.
 * Does nothing outside co-op or if the run is already ending.
 * @param reason - What to tell the player
 * @param bye - Tell the partner why, when this client decided to end the run
 */
export function endCoopRun(reason: CoopEndReason, bye?: CoopByeReason): void {
  const transport = currentTransport();
  if (!transport || ending.has(transport)) {
    return;
  }
  ending.add(transport);
  const session = coopSession;
  if (bye) {
    transport.send({ t: "bye", reason: bye });
  }
  showCoopBanner(coopText(reason satisfies CoopTextKey));
  setTimeout(async () => {
    await saveWaveStart(session);
    lobbyExit.leave();
    // The run may end in the middle of a turn: stop what is still running, so nothing touches the scene it resets.
    globalScene.phaseManager.clearAllPhases();
    globalScene.tweens.killAll();
    coopExit.returnToTitle();
  }, coopExit.noticeMs);
}
