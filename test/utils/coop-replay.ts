/**
 * Record-then-replay desync testing for co-op.
 *
 * Two games cannot run in one process (`globalScene` and `Phaser.Math.RND` are global), so instead:
 * 1. run once as the host with the host's account data, recording both players' inputs and the state hashes;
 * 2. run again in the same process as the guest with the guest's account data,
 *    taking the host's inputs from the recording, and compare the hash sequences.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { activeOverrides } from "#app/overrides";
import { withCoopBallTarget } from "#coop/coop-ball";
import type { CoopChecksum } from "#coop/coop-desync";
import { createCoopGameMode, startCoopRun } from "#coop/coop-game-start";
import type {
  CoopAccountSnapshot,
  CoopMessage,
  CoopRewardAction,
  CoopRole,
  CoopStarterPayload,
  CoopTurnCommandPayload,
} from "#coop/coop-protocol";
import { getCoopRewardGen, submitCoopRewardAction } from "#coop/coop-reward";
import { coopSession, setCoopSession } from "#coop/coop-session";
import { createAccountSnapshot } from "#coop/coop-sim-data";
import { CoopStarterSelection, type CoopStartInfo } from "#coop/coop-starter-selection";
import { type CoopStateSnapshot, captureCoopState, hashCoopState } from "#coop/coop-state-hash";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Gender } from "#data/gender";
import { BattleStyle } from "#enums/battle-style";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { DexAttr } from "#enums/dex-attr";
import { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import type { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { Unlockables } from "#enums/unlockables";
import type { CommandPhase } from "#phases/command-phase";
import type { SelectModifierPhase } from "#phases/select-modifier-phase";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import type { GameData } from "#system/game-data";
import { GameManager } from "#test/framework/game-manager";
import { PromptHandler } from "#test/helpers/prompt-handler";
import {
  CoopTestPartner,
  synthesizeBallCommand,
  synthesizeMoveCommand,
  synthesizeRunCommand,
} from "#test/utils/coop-partner";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import { getEnumValues } from "#utils/enums";
import { vi } from "vitest";

/**
 * One input a player makes for their own field slot in a turn.
 * - `move`: a move in the moveset, with a target if the move asks for one
 * - `ball`: a ball thrown at an enemy
 * - `run`: run away (a flee proposal while the partner has not run too)
 * - `fleeAnswer`: the answer to the partner's flee proposal (accepting runs too)
 */
export type CoopReplayAction =
  | { kind: "move"; moveId: MoveId; target?: BattlerIndex }
  | { kind: "ball"; ball: PokeballType; target: BattlerIndex }
  | { kind: "run" }
  | { kind: "fleeAnswer"; accept: boolean };

/** A message one player's client sent, filed under the battle turn it was sent in. */
export interface CoopReplayInput {
  by: CoopRole;
  wave: number;
  turn: number;
  message: CoopMessage;
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

/** What each player does on a wave's reward screen, in order (a reroll moves on to the next screen). */
export type CoopReplayRewardFn = (wave: number) => Partial<Record<CoopRole, CoopRewardAction[]>>;

/** A player's inputs for a turn, in the order they make them (for example a declined flee, then a move). */
export type CoopReplayCommandFn = (wave: number, turn: number) => CoopReplayAction | CoopReplayAction[];

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
  /** Further starters of each player, after the first */
  benches?: Partial<Record<CoopRole, SpeciesId[]>>;
  /** Number of waves to finish (by winning, catching everything or fleeing) */
  waves: number;
  /** Stop after this many turns even if the waves are not finished */
  turns?: number;
  /** Reward screen actions per wave. Default: the wave's picker skips the reward, the other player does nothing */
  rewards?: CoopReplayRewardFn;
  /** Runs once the battle has started, before the first input (both runs must do the same) */
  onStart?: (game: GameManager) => void;
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
  game.onNextPrompt("TitlePhase", UiMode.TITLE, async () => {
    game.scene.gameMode = createCoopGameMode();
    const selectStarterPhase = new SelectStarterPhase();
    game.scene.phaseManager.pushNew("EncounterPhase", false);
    await startCoopRun(options.role, transport, options.start, () => selectStarterPhase.initBattle([]));
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

/** The messages a player's client sends for their actions, as its `CommandPhase` and flee prompt would. */
function synthesizeMessages(by: CoopRole, actions: CoopReplayAction[]): CoopMessage[] {
  const { waveIndex: wave, turn } = globalScene.currentBattle;
  const fieldIndex = FIELD_BY_ROLE[by];
  const command = (payload: CoopTurnCommandPayload): CoopMessage => ({
    t: "turnCommand",
    wave,
    turn,
    command: payload,
  });
  return actions.map(action => {
    switch (action.kind) {
      case "move":
        return command(synthesizeMoveCommand(fieldIndex, action.moveId, action.target));
      case "ball":
        return command(synthesizeBallCommand(fieldIndex, action.ball, action.target));
      case "run":
        return command(synthesizeRunCommand(fieldIndex));
      case "fleeAnswer":
        return action.accept
          ? command(synthesizeRunCommand(fieldIndex))
          : { t: "confirm", kind: "flee", wave, turn, accepted: false };
    }
    throw new Error(`unknown replay action ${JSON.stringify(action)}`);
  });
}

/** Queue the local player's actions as UI inputs, in order. */
function queueLocalActions(game: GameManager, role: CoopRole, actions: CoopReplayAction[]): void {
  const commandPhase = () => game.scene.phaseManager.getCurrentPhase() as CommandPhase;
  for (const action of actions) {
    switch (action.kind) {
      case "move":
        game.move.select(action.moveId, FIELD_BY_ROLE[role], action.target);
        break;
      case "ball":
        game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
          withCoopBallTarget(action.target, () => commandPhase().handleCommand(Command.BALL, action.ball));
        });
        break;
      case "run":
        game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
          commandPhase().handleCommand(Command.RUN, 0);
        });
        break;
      case "fleeAnswer":
        game.onNextPrompt("CommandPhase", UiMode.CONFIRM, () => {
          const handler = game.scene.ui.getHandler() as ConfirmUiHandler;
          handler.setCursor(action.accept ? 0 : 1);
          handler.processInput(Button.ACTION);
        });
        break;
    }
  }
}

/**
 * Make both players' inputs for the current turn.
 * The local player's go through the UI. The partner's client is not running, so the messages it would send go out
 * over the connection instead: made up from its actions when recording, or taken from the log when replaying.
 */
function inputTurn(game: GameManager, options: CoopReplayOptions, log: CoopReplayLog, partner: CoopTestPartner): void {
  const { role, localCommand, remote } = options;
  const by: CoopRole = role === "host" ? "guest" : "host";
  const { waveIndex: wave, turn } = game.scene.currentBattle;
  const send = (messages: CoopMessage[]) => {
    for (const message of messages) {
      log.inputs.push({ by, wave, turn, message });
      partner.send(message);
    }
  };
  if ("log" in remote) {
    send(remote.log.inputs.filter(i => i.by === by && i.wave === wave && i.turn === turn).map(i => i.message));
  } else {
    // An answer to a flee proposal (and whatever follows it) only makes sense once the proposal was made.
    const actions = [remote.command(wave, turn)].flat();
    const answer = actions.findIndex(a => a.kind === "fleeAnswer");
    send(synthesizeMessages(by, answer === -1 ? actions : actions.slice(0, answer)));
    if (answer !== -1) {
      const deferred = synthesizeMessages(by, actions.slice(answer));
      const off = partner.onReceive(message => {
        if (
          message.t === "turnCommand"
          && message.wave === wave
          && message.turn === turn
          && message.command.turnCommand.command === Command.RUN
        ) {
          off();
          send(deferred);
        }
      });
    }
  }
  queueLocalActions(game, role, [localCommand(wave, turn)].flat());
}

/** Where reward screen messages are filed: they belong to the wave, not to a turn. */
const REWARD_TURN = 0;

/** Wait until the reward screen with this number is open, running the phases up to it. */
async function toRewardScreen(game: GameManager, gen: number): Promise<SelectModifierPhase> {
  for (;;) {
    const phase = game.scene.phaseManager.getCurrentPhase();
    if (phase.is("SelectModifierPhase") && getCoopRewardGen() === gen) {
      return phase;
    }
    if (getCoopRewardGen() > gen) {
      throw new Error(`reward screen ${gen} closed before the local actions were made`);
    }
    await game.phaseInterceptor.to("SelectModifierPhase");
  }
}

/** The screen number each action is made on, the first one on `first`: a reroll opens the next screen. */
function screensFor(actions: CoopRewardAction[], first: number): number[] {
  let gen = first;
  return actions.map(action => (action.kind === "reroll" ? gen++ : gen));
}

/**
 * Make both players' reward screen actions for the wave that just ended, then go on to the next wave.
 * The partner's: made up as the guest's requests when recording as the host (the host numbers them), or the recorded
 * host's numbered events when replaying as the guest. A recorded event for one of the local player's own requests
 * is only sent once the local client made that request, as the host would.
 */
async function inputRewards(
  game: GameManager,
  options: CoopReplayOptions,
  log: CoopReplayLog,
  partner: CoopTestPartner,
): Promise<void> {
  const { role, remote } = options;
  const by: CoopRole = role === "host" ? "guest" : "host";
  const wave = game.scene.currentBattle.waveIndex;
  const picker = coopSession!.pickerForWave(wave);
  const scripts = options.rewards?.(wave) ?? {};
  const actionsOf = (r: CoopRole): CoopRewardAction[] => scripts[r] ?? (r === picker ? [{ kind: "skip" }] : []);
  const first = getCoopRewardGen() + 1;
  const send = (message: CoopMessage) => {
    log.inputs.push({ by, wave, turn: REWARD_TURN, message });
    partner.send(message);
  };

  if ("log" in remote) {
    const recorded = remote.log.inputs.filter(i => i.by === by && i.message.t === "reward" && i.message.wave === wave);
    for (const { message } of recorded) {
      if (message.t !== "reward" || message.by === by) {
        send(message);
        continue;
      }
      const off = partner.onReceive(sent => {
        if (sent.t === "reward" && sent.req === message.req) {
          off();
          send(message);
        }
      });
    }
  } else {
    // Only the guest's requests are made up: the host under test numbers them.
    const actions = actionsOf(by);
    const gens = screensFor(actions, first);
    actions.forEach((action, i) => {
      send({ t: "reward", wave, gen: gens[i], req: remoteRequests.count++, by, action });
    });
  }

  const local = actionsOf(role);
  const gens = screensFor(local, first);
  for (const [i, action] of local.entries()) {
    const phase = await toRewardScreen(game, gens[i]);
    submitCoopRewardAction(phase, action);
  }
  await game.phaseInterceptor.to("TurnInitPhase");
  await game.phaseInterceptor.to("CommandPhase");
}

/** Where a message the local client sent is filed in the log, `null` for messages that are not inputs. */
function fileAt(game: GameManager, message: CoopMessage): { wave: number; turn: number } | null {
  switch (message.t) {
    case "reward":
      return { wave: message.wave, turn: REWARD_TURN };
    case "turnCommand":
      return { wave: message.wave, turn: message.turn };
    case "confirm":
    case "choice": {
      const { waveIndex, turn } = game.scene.currentBattle;
      return "turn" in message && message.turn !== undefined
        ? { wave: message.wave, turn: message.turn }
        : { wave: waveIndex, turn };
    }
    default:
      return null;
  }
}

/** The partner's request count in a recording run. */
const remoteRequests = { count: 0 };

/** The inputs one player made, in order. */
export function inputsBy(log: CoopReplayLog, role: CoopRole): CoopReplayInput[] {
  return log.inputs.filter(i => i.by === role);
}

/**
 * Play a co-op game as one role, recording inputs and state hashes at the start of every wave and the end of every turn.
 * Co-op makes every battle double. Overrides: level 100 players, enemies that only use Splash, no trainer waves,
 * and real shiny rolls for enemies (so the trainer id matters).
 */
export async function runCoopReplay(game: GameManager, options: CoopReplayOptions): Promise<CoopReplayLog> {
  game.override.disableShinies = false;
  game.override.startingLevel(100).enemyMoveset(MoveId.SPLASH).disableTrainerWaves();
  game.override.shiny(false);

  const snapshots = prepareAccounts(game, options);
  const start: CoopStartInfo = {
    seed: options.seed ?? "coop-replay",
    accounts: { host: options.worldDataOverride ?? snapshots.host, guest: snapshots.guest },
    picks: {
      host: [options.species[0], ...(options.benches?.host ?? [])].map(createTestStarterPayload),
      guest: [options.species[1], ...(options.benches?.guest ?? [])].map(createTestStarterPayload),
    },
    timedEvent: null,
  };
  const log: CoopReplayLog = { inputs: [], checksums: [], enemyIds: [], states: [] };
  const partner = new CoopTestPartner(options.role);
  remoteRequests.count = 0;
  let read = 0;
  /** File what the local client sent since the last call. */
  const collectSent = () => {
    for (const message of partner.received.slice(read)) {
      const at = fileAt(game, message);
      if (at) {
        log.inputs.push({ by: options.role, ...at, message });
      }
    }
    read = partner.received.length;
  };
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
    await startCoopBattle(game, { role: options.role, start, transport: partner.localTransport });
    options.onStart?.(game);
    waveStart();

    let finished = 0;
    let turns = 0;
    while (finished < options.waves && turns < (options.turns ?? Number.POSITIVE_INFINITY)) {
      inputTurn(game, options, log, partner);
      await game.toEndOfTurn();
      // Let the last messages of the turn arrive before filing them.
      await new Promise(resolve => setTimeout(resolve, 0));
      collectSent();
      checkpoint();
      turns++;

      const fled = game.scene.currentBattle.successfulRun;
      if (!fled && !game.isVictory()) {
        await game.toNextTurn();
      } else if (++finished < options.waves) {
        if (fled) {
          // No rewards after fleeing.
          await game.phaseInterceptor.to("TurnInitPhase");
          await game.phaseInterceptor.to("CommandPhase");
        } else {
          await inputRewards(game, options, log, partner);
          await new Promise(resolve => setTimeout(resolve, 0));
          collectSent();
        }
        waveStart();
      }
    }
  } finally {
    setCoopSession(null);
  }

  return log;
}
