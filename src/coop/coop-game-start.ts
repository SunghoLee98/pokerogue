/**
 * Starting a co-op run: the game mode, the session and the shared party.
 * @module
 */

import { type GameMode, getGameMode } from "#app/game-mode";
import { GameModes } from "#enums/game-modes";

/** Co-op is classic with the `isCoop` flag; there is no `GameModes` entry for it. */
export function createCoopGameMode(): GameMode {
  const gameMode = getGameMode(GameModes.CLASSIC);
  gameMode.isCoop = true;
  return gameMode;
}
