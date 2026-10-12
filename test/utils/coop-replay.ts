/**
 * Record-then-replay desync testing for co-op.
 *
 * Two games cannot run in one process (`globalScene` and `Phaser.Math.RND` are global), so instead:
 * 1. run once as the host with the host's account data, recording both players' inputs and the state hashes;
 * 2. run again in the same process as the guest with the guest's account data,
 *    taking the host's inputs from the recording, and compare the hash sequences.
 * @module
 */

import { settings } from "#app/global-settings-manager";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { activeOverrides } from "#app/overrides";
import type { CoopChecksum } from "#coop/coop-desync";
import { createCoopGameMode, startCoopRun } from "#coop/coop-game-start";
import type { CoopAccountSnapshot, CoopRole, CoopStarterPayload } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import { createAccountSnapshot } from "#coop/coop-sim-data";
import { CoopStarterSelection, type CoopStartInfo } from "#coop/coop-starter-selection";
import { type CoopStateSnapshot, captureCoopState, hashCoopState } from "#coop/coop-state-hash";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Gender } from "#data/gender";
import { BattleStyle } from "#enums/battle-style";
import { BattlerIndex } from "#enums/battler-index";
import { DexAttr } from "#enums/dex-attr";
import { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { Unlockables } from "#enums/unlockables";
import { SelectStarterPhase } from "#phases/select-starter-phase";
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
  /** Replaces the host snapshot in the start message, to inject a divergence */
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

export interface CoopBattleStartOptions {
  role: CoopRole;
  start: CoopStartInfo;
  /** The connection to the partner. Default: one side of a fresh loopback pair */
  transport?: CoopTransport;
}

/**
 * Transition from the title screen to the first command of a co-op run, through the same path the game takes
 * once both players are ready: {@linkcode startCoopRun} followed by the tail of `SelectStarterPhase.initBattle`.
 * Mirrors `ClassicModeHelper.startBattle` (same test overrides, same switch prompt handling).
 */
export async function startCoopBattle(game: GameManager, options: CoopBattleStartOptions): Promise<void> {
  await game.runToTitle();

  if (game.override.disableShinies) {
    game.override.shiny(false).enemyShiny(false);
  }
  if (game.override.normalizeIVs) {
    game.override.playerIVs(31).enemyIVs(31);
  }
  if (game.override.normalizeNatures) {
    game.override.nature(Nature.HARDY).enemyNature(Nature.HARDY);
  }

  const transport = options.transport ?? createLoopbackPair()[options.role];
  game.onNextPrompt("TitlePhase", UiMode.TITLE, () => {
    game.scene.gameMode = createCoopGameMode();
    const selectStarterPhase = new SelectStarterPhase();
    game.scene.phaseManager.pushNew("EncounterPhase", false);
    startCoopRun(options.role, transport, options.start, () => selectStarterPhase.initBattle([]));
  });

  await game.phaseInterceptor.to("EncounterPhase");
  if (activeOverrides.ENEMY_HELD_ITEMS_OVERRIDE.length === 0 && game.override.removeEnemyStartingItems) {
    game.removeEnemyHeldItems();
  }

  if (settings.general.battleStyle === BattleStyle.SWITCH) {
    for (let i = 0; i < 2; i++) {
      game.onNextPrompt(
        "CheckSwitchPhase",
        UiMode.CONFIRM,
        () => {
          game.setMode(UiMode.MESSAGE);
          game.endPhase();
        },
        () => game.isCurrentPhase("CommandPhase") || game.isCurrentPhase("TurnInitPhase"),
      );
    }
  }

  await game.phaseInterceptor.to("CommandPhase");
}

export interface CoopSelectionSide {
  picks: CoopStarterPayload[];
  account: CoopAccountSnapshot;
}

/**
 * Run the starter selection for both players over a loopback connection until the host starts the run.
 * @returns Each side's start information (they must be equal) and the connected transports
 */
export async function selectCoopStart(
  sides: Record<CoopRole, CoopSelectionSide>,
  seed = "coop-select",
): Promise<{ starts: Record<CoopRole, CoopStartInfo>; transports: Record<CoopRole, CoopTransport> }> {
  const transports = createLoopbackPair();
  const { joinCode } = await transports.host.host();
  await transports.guest.join(joinCode);
  const selections = {
    host: new CoopStarterSelection("host", transports.host, {
      getAccount: () => sides.host.account,
      createSeed: () => seed,
      getTimedEvent: () => null,
    }),
    guest: new CoopStarterSelection("guest", transports.guest, { getAccount: () => sides.guest.account }),
  };
  selections.guest.setReady(sides.guest.picks);
  selections.host.setReady(sides.host.picks);
  // Let the loopback deliver the guest's selection and the host's start.
  await new Promise<void>(resolve => setTimeout(resolve, 0));

  const host = selections.host.startInfo;
  const guest = selections.guest.startInfo;
  selections.host.dispose();
  selections.guest.dispose();
  if (!host || !guest) {
    throw new Error("the co-op starter selection did not start");
  }
  return { starts: { host, guest }, transports };
}

/** The field slot each role commands. */
const FIELD_BY_ROLE = {
  host: BattlerIndex.PLAYER,
  guest: BattlerIndex.PLAYER_2,
} as const satisfies Record<CoopRole, BattlerIndex>;

const CAUGHT_ATTR = DexAttr.NON_SHINY | DexAttr.MALE | DexAttr.DEFAULT_VARIANT | DexAttr.DEFAULT_FORM;

/** The snapshot an account would produce, given the snapshot of the default test game data. */
function snapshotFor(base: CoopAccountSnapshot, account: CoopTestAccount): CoopAccountSnapshot {
  const eggMoves: Record<number, number> = {};
  for (const [speciesId, bits] of Object.entries({ ...base.eggMoves, ...account.eggMoves })) {
    if (bits) {
      eggMoves[Number(speciesId)] = bits;
    }
  }
  return {
    trainerId: account.trainerId,
    secretId: account.secretId,
    caughtSpecies: [...new Set([...base.caughtSpecies, ...account.caughtSpecies])].sort((a, b) => a - b),
    eggMoves,
    unlocks: getEnumValues(Unlockables).filter(u => account.unlocks.includes(u)),
  };
}

/**
 * The snapshot a test account produces.
 * @param gameData - Game data still holding the default test data, which the account is applied on top of
 */
export function snapshotForTestAccount(gameData: GameData, account: CoopTestAccount): CoopAccountSnapshot {
  return snapshotFor(createAccountSnapshot(gameData), account);
}

/** Make the local game data look like the given account. */
export function applyTestAccount(gameData: GameData, account: CoopTestAccount): void {
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

/**
 * Make the local game data the role's account.
 * @returns Both players' account snapshots
 */
function prepareAccounts(game: GameManager, options: CoopReplayOptions): Record<CoopRole, CoopAccountSnapshot> {
  const { role, accounts } = options;
  const gameData = game.scene.gameData;
  const base = createAccountSnapshot(gameData);
  applyTestAccount(gameData, accounts[role]);

  const snapshots = { host: snapshotFor(base, accounts.host), guest: snapshotFor(base, accounts.guest) };
  if (JSON.stringify(createAccountSnapshot(gameData)) !== JSON.stringify(snapshots[role])) {
    throw new Error(`local game data does not match the ${role} account snapshot`);
  }
  return snapshots;
}

/**
 * A fixed starter payload for a species, as a player would send it.
 * Fixed values (no random rolls), so that recording and replaying runs pick exactly the same starters.
 */
export function createTestStarterPayload(speciesId: SpeciesId): CoopStarterPayload {
  const species = speciesDataRegistry.getSpecies(speciesId);
  return {
    speciesId,
    formIndex: 0,
    gender: species.malePercent === null ? Gender.GENDERLESS : Gender.MALE,
    shiny: false,
    variant: 0,
    abilityIndex: 0,
    passive: false,
    nature: Nature.HARDY,
    ivs: [20, 20, 20, 20, 20, 20],
    moveset: [],
    teraType: species.type1,
    friendship: species.baseFriendship,
    pokeball: PokeballType.POKEBALL,
    pokerus: false,
    luck: 0,
  };
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

  const snapshots = prepareAccounts(game, options);
  const start: CoopStartInfo = {
    seed: options.seed ?? "coop-replay",
    accounts: { host: options.worldDataOverride ?? snapshots.host, guest: snapshots.guest },
    picks: {
      host: [createTestStarterPayload(options.species[0])],
      guest: [createTestStarterPayload(options.species[1])],
    },
    timedEvent: null,
  };
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
    // The real co-op start: both clients sow the shared seed before creating the starters, so starter ids agree,
    // and the starters' owners are registered from the picks.
    await startCoopBattle(game, { role: options.role, start });
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
