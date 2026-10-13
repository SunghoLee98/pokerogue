/**
 * The co-op lobby: the state between connecting and starting the run, while both players pick starters.
 * Once the run starts, the lobby hands its connection over to the co-op session.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { type CoopConnection, getLocalCoopInfo } from "#coop/coop-connect";
import { startCoopRun } from "#coop/coop-game-start";
import type { CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import { createAccountSnapshot } from "#coop/coop-sim-data";
import { CoopStarterSelection, type CoopStarterSelectionOptions } from "#coop/coop-starter-selection";
import type { CoopTransport } from "#coop/coop-transport";

export interface CoopLobby {
  readonly role: CoopRole;
  readonly transport: CoopTransport;
  readonly peerAccountName: string;
  readonly selection: CoopStarterSelection;
}

/** The lobby while co-op players pick their starters, or `null`. */
export let coopLobby: CoopLobby | null = null;

/**
 * Enter the lobby after connecting.
 * @param options - Starter selection options; by default the local account snapshot is taken from `gameData`
 */
export function openCoopLobby(
  connection: CoopConnection,
  options: CoopStarterSelectionOptions = { getAccount: () => createAccountSnapshot(globalScene.gameData) },
): CoopLobby {
  leaveCoop();
  coopLobby = {
    role: connection.role,
    transport: connection.transport,
    peerAccountName: connection.peerAccountName,
    selection: new CoopStarterSelection(connection.role, connection.transport, options),
  };
  return coopLobby;
}

/**
 * Leave co-op: tell the partner, close the connection and drop the lobby and the session.
 * Called whenever the game returns to the title screen; does nothing outside co-op.
 */
export function leaveCoop(): void {
  const transports = new Set<CoopTransport>();
  if (coopLobby) {
    coopLobby.selection.dispose();
    transports.add(coopLobby.transport);
    coopLobby = null;
  }
  if (coopSession) {
    transports.add(coopSession.transport);
    setCoopSession(null);
  }
  for (const transport of transports) {
    transport.send({ t: "bye" });
    transport.close();
  }
}

/**
 * Start the run both players agreed on in the lobby; the session takes over the lobby's connection.
 * @param initBattle - Continues the solo start with the party in place
 * @throws If there is no lobby or the selection has not started
 */
export function startCoopRunFromLobby(initBattle: () => void): Promise<void> {
  const lobby = coopLobby;
  const start = lobby?.selection.startInfo;
  if (!lobby || !start) {
    throw new Error("no agreed co-op run to start");
  }
  lobby.selection.dispose();
  coopLobby = null;
  const localName = getLocalCoopInfo().accountName;
  const participants =
    lobby.role === "host"
      ? { host: localName, guest: lobby.peerAccountName }
      : { host: lobby.peerAccountName, guest: localName };
  return startCoopRun(lobby.role, lobby.transport, start, initBattle, participants);
}
