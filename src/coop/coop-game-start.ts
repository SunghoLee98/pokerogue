/**
 * Starting a co-op run: the game mode, the session and the shared party.
 *
 * Both clients run the same steps from the same `start` message:
 * 1. open the session with both account snapshots (so nothing falls back to the local account);
 * 2. sow the shared seed, then create the host's picks followed by the guest's picks.
 *    Creating a pokemon draws its id and tera type roll from the shared RNG, so the seed and the order make both
 *    clients agree on every starter id;
 * 3. order the party so that field slot 0 is the host's first pick and slot 1 the guest's.
 * @module
 */

import { type GameMode, getGameMode } from "#app/game-mode";
import { globalScene } from "#app/global-scene";
import type { CoopRole } from "#coop/coop-protocol";
import { CoopSession, setCoopSession } from "#coop/coop-session";
import { createStarterFromPayload } from "#coop/coop-starter-payload";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import type { CoopTransport } from "#coop/coop-transport";
import { GameModes } from "#enums/game-modes";
import type { PlayerPokemon } from "#field/pokemon";

/**
 * The session slot a co-op run saves to, apart from the solo slots 0-4 (spec 4.6).
 * Until the backend accepts it, saves to it fail without touching any solo slot.
 */
export const COOP_SESSION_SLOT = 5;

/** Co-op is classic with the `isCoop` flag; there is no `GameModes` entry for it. */
export function createCoopGameMode(): GameMode {
  const gameMode = getGameMode(GameModes.CLASSIC);
  gameMode.isCoop = true;
  return gameMode;
}

/** Open the co-op session with both players' account snapshots and names, and the host's timed event. */
export function beginCoopSession(
  role: CoopRole,
  transport: CoopTransport,
  start: CoopStartInfo,
  participants: Record<CoopRole, string> = { host: "", guest: "" },
): CoopSession {
  const session = new CoopSession(role, transport);
  session.setAccountSnapshot("host", start.accounts.host);
  session.setAccountSnapshot("guest", start.accounts.guest);
  session.timedEvent = start.timedEvent;
  session.participants = { ...participants };
  setCoopSession(session);
  return session;
}

/**
 * Sow the shared seed and create both players' starters, registering their owners.
 * Requires an open session and a classic game mode.
 * @returns The party in field order: the host's first pick, the guest's first pick, then the rest of each
 */
export function assembleCoopParty(start: CoopStartInfo, level: number): PlayerPokemon[] {
  globalScene.setSeed(start.seed);
  globalScene.resetSeed();
  const host = start.picks.host.map(payload => createStarterFromPayload(payload, level, "host"));
  const guest = start.picks.guest.map(payload => createStarterFromPayload(payload, level, "guest"));
  return [...host.slice(0, 1), ...guest.slice(0, 1), ...host.slice(1), ...guest.slice(1)];
}

/**
 * Start the agreed co-op run: open the session, switch to the co-op save slot, set the starting money,
 * create the party and load it,
 * then hand over to the rest of the solo start (`SelectStarterPhase.initBattle` with no further starters).
 * @param initBattle - Continues the solo start with the party already in place
 * @param participants - Both players' account names, saved with the run
 */
export async function startCoopRun(
  role: CoopRole,
  transport: CoopTransport,
  start: CoopStartInfo,
  initBattle: () => void,
  participants?: Record<CoopRole, string>,
): Promise<void> {
  beginCoopSession(role, transport, start, participants);
  globalScene.sessionSlotId = COOP_SESSION_SLOT;
  // Money is part of the shared state; set it here rather than rely on what each client's screen did.
  globalScene.money = globalScene.gameMode.getStartingMoney();
  const party = assembleCoopParty(start, globalScene.gameMode.getStartingLevel());
  globalScene.getPlayerParty().push(...party);
  await Promise.all(party.map(pokemon => pokemon.loadAssets()));
  initBattle();
}
