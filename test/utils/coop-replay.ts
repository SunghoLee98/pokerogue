/**
 * Record-then-replay desync testing for co-op.
 *
 * Two games cannot run in one process (`globalScene` and `Phaser.Math.RND` are global), so instead:
 * 1. run once as the host with the host's account data, recording both players' inputs and the state hashes;
 * 2. run again in the same process as the guest with the guest's account data,
 *    taking the host's inputs from the recording, and compare the hash sequences.
 * @module
 */

import type { CoopChecksum } from "#coop/coop-desync";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { CoopSession, setCoopSession } from "#coop/coop-session";
import { createAccountSnapshot } from "#coop/coop-sim-data";
import { type CoopStateSnapshot, captureCoopState, hashCoopState } from "#coop/coop-state-hash";
import { createLoopbackPair } from "#coop/loopback-transport";
import { BattlerIndex } from "#enums/battler-index";
import { DexAttr } from "#enums/dex-attr";
import { MoveId } from "#enums/move-id";
import type { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import type { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { PromptHandler } from "#test/helpers/prompt-handler";
import { getEnumValues } from "#utils/enums";
import { vi } from "vitest";

/** One player's battle command for their own field slot. */
export interface CoopReplayCommand {
  moveId: MoveId;
  target: BattlerIndex;
}

export interface CoopReplayInput extends CoopReplayCommand {
  by: CoopRole;
  wave: number;
  turn: number;
}

export interface CoopReplayLog {
  inputs: CoopReplayInput[];
  checksums: CoopChecksum[];
  /** Enemy pokemon ids at the start of each wave, for crafting account data in scenarios */
  enemyIds: number[][];
  /** The hashed state at each checkpoint, to explain a desync */
  states: CoopStateSnapshot[];
}

/** How a test account differs from the default test game data. */
export interface CoopTestAccount {
  trainerId: number;
  secretId: number;
  unlocks: Unlockables[];
  /** Species to mark as caught on top of the default dex */
  caughtSpecies: SpeciesId[];
  /** Root species → egg move bits, on top of the default starter data */
  eggMoves: Partial<Record<SpeciesId, number>>;
}

export type CoopReplayCommandFn = (wave: number, turn: number) => CoopReplayCommand;

export interface CoopReplayOptions {
  /** The role this run plays */
  role: CoopRole;
  accounts: Record<CoopRole, CoopTestAccount>;
  /** Commands of the local player */
  localCommand: CoopReplayCommandFn;
  /** Where the other player's commands come from: live (when recording) or a recorded log (when replaying) */
  remote: { command: CoopReplayCommandFn } | { log: CoopReplayLog };
  /** Replaces the host snapshot the simulation reads, to inject a divergence */
  worldDataOverride?: CoopAccountSnapshot;
  /** The two starters: index 0 belongs to the host, index 1 to the guest */
  species: [SpeciesId, SpeciesId];
  /** Number of waves to clear */
  waves: number;
  /** The shared seed; both runs must use the same one. Default `"coop-replay"` */
  seed?: string;
}

/**
 * Start a fresh game in the middle of a test, for the second run of a record-replay pair.
 * A test normally creates one {@linkcode GameManager}. The previous one's spies (UI prompt hooks, overrides)
 * are restored first, and the per-test prompt interval is cleared the same way the global `afterEach` hook clears it.
 */
export function createFreshGameManager(phaserGame: Phaser.Game): GameManager {
  vi.restoreAllMocks();
  clearInterval(PromptHandler.runInterval);
  PromptHandler.runInterval = undefined;
  return new GameManager(phaserGame);
}

/** The field slot each role commands. */
const FIELD_BY_ROLE = {
  host: BattlerIndex.PLAYER,
  guest: BattlerIndex.PLAYER_2,
} as const satisfies Record<CoopRole, BattlerIndex>;

const CAUGHT_ATTR = DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT | DexAttr.DEFAULT_FORM;

/** The snapshot an account would produce, given the snapshot of the default test game data. */
function snapshotFor(base: CoopAccountSnapshot, account: CoopTestAccount): CoopAccountSnapshot {
  return {
    trainerId: account.trainerId,
    secretId: account.secretId,
    caughtSpecies: [...new Set([...base.caughtSpecies, ...account.caughtSpecies])].sort((a, b) => a - b),
    eggMoves: { ...base.eggMoves, ...account.eggMoves },
    unlocks: getEnumValues(Unlockables).filter(u => account.unlocks.includes(u)),
  };
}

/** Make the local game data look like the given account. */
function applyAccount(gameData: GameData, account: CoopTestAccount): void {
  gameData.trainerId = account.trainerId;
  gameData.secretId = account.secretId;
  for (const unlockable of getEnumValues(Unlockables)) {
    gameData.unlocks[unlockable] = account.unlocks.includes(unlockable);
  }
  for (const speciesId of account.caughtSpecies) {
    gameData.dexData[speciesId].caughtAttr ||= CAUGHT_ATTR;
  }
  for (const [speciesId, bits] of Object.entries(account.eggMoves)) {
    gameData.starterData[Number(speciesId)].eggMoves = bits;
  }
}

function findRecordedCommand(log: CoopReplayLog, by: CoopRole, wave: number, turn: number): CoopReplayCommand {
  const input = log.inputs.find(i => i.by === by && i.wave === wave && i.turn === turn);
  if (!input) {
    throw new Error(`no recorded ${by} input for wave ${wave} turn ${turn}`);
  }
  return { moveId: input.moveId, target: input.target };
}

/** Make the local game data the role's account, and start a session holding both players' snapshots. */
function startSession(game: GameManager, options: CoopReplayOptions): CoopSession {
  const { role, accounts } = options;
  const gameData = game.scene.gameData;
  const base = createAccountSnapshot(gameData);
  applyAccount(gameData, accounts[role]);

  const snapshots = { host: snapshotFor(base, accounts.host), guest: snapshotFor(base, accounts.guest) };
  if (JSON.stringify(createAccountSnapshot(gameData)) !== JSON.stringify(snapshots[role])) {
    throw new Error(`local game data does not match the ${role} account snapshot`);
  }

  const session = new CoopSession(role, createLoopbackPair()[role]);
  session.setAccountSnapshot("host", options.worldDataOverride ?? snapshots.host);
  session.setAccountSnapshot("guest", snapshots.guest);
  setCoopSession(session);
  return session;
}

/** Select both players' commands for the current turn, recording them. */
function selectCommands(game: GameManager, options: CoopReplayOptions, log: CoopReplayLog): void {
  const { role, localCommand, remote } = options;
  const { waveIndex: wave, turn } = game.scene.currentBattle;
  for (const by of ["host", "guest"] as const) {
    let command: CoopReplayCommand;
    if (by === role) {
      command = localCommand(wave, turn);
    } else if ("log" in remote) {
      command = findRecordedCommand(remote.log, by, wave, turn);
    } else {
      command = remote.command(wave, turn);
    }
    log.inputs.push({ by, wave, turn, ...command });
    game.move.select(command.moveId, FIELD_BY_ROLE[by], command.target);
  }
}

/**
 * Play a co-op game as one role, recording inputs and state hashes at the start of every wave and the end of every turn.
 * Overrides: double battles, level 100 players, enemies that only use Splash, no trainer waves,
 * and real shiny rolls for enemies (so the trainer id matters).
 */
export async function runCoopReplay(game: GameManager, options: CoopReplayOptions): Promise<CoopReplayLog> {
  game.override.disableShinies = false;
  game.override.battleStyle("double").startingLevel(100).enemyMoveset(MoveId.SPLASH).disableTrainerWaves();
  game.override.shiny(false);

  const session = startSession(game, options);
  const log: CoopReplayLog = { inputs: [], checksums: [], enemyIds: [], states: [] };
  const checkpoint = () => {
    const { waveIndex, turn } = game.scene.currentBattle;
    const state = captureCoopState();
    log.states.push(state);
    log.checksums.push({ wave: waveIndex, turn, hash: hashCoopState(state) });
  };
  const waveStart = () => {
    log.enemyIds.push(game.scene.getEnemyParty().map(p => p.id));
    checkpoint();
  };

  try {
    // Both clients sow the shared seed before any pokemon is created, so starter ids agree.
    game.override.seed(options.seed ?? "coop-replay");
    await game.classicMode.startBattle(...options.species);
    const party = game.scene.getPlayerParty();
    session.ownership.set(party[0].id, "host");
    session.ownership.set(party[1].id, "guest");
    waveStart();

    let cleared = 0;
    while (cleared < options.waves) {
      selectCommands(game, options, log);
      await game.toEndOfTurn();
      checkpoint();

      if (!game.isVictory()) {
        await game.toNextTurn();
      } else if (++cleared < options.waves) {
        await game.toNextWave();
        waveStart();
      }
    }
  } finally {
    setCoopSession(null);
  }

  return log;
}
