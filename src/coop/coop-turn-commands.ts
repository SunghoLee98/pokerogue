/**
 * Splitting battle commands between the two co-op players (spec 3.3, 4.4 "명령 입력", "도망 동의").
 *
 * Each player commands only the field slots holding their own pokemon. For every turn, on both clients:
 * 1. the local player's slots are input first (a partner slot's `CommandPhase` that comes first is moved behind them),
 *    so both players input at the same time;
 * 2. a slot whose command is automatic (Commander, a locked-in or charging move) is resolved by each simulation alone;
 * 3. a local slot's final command (after target selection) is sent as a `turnCommand`;
 * 4. a partner slot shows a waiting text and takes the partner's `turnCommand` as is.
 *
 * Fleeing needs both players: when both slots needed input, a RUN only counts if the other slot runs too.
 * A partner's RUN shown while the local player is still choosing is a flee proposal they can accept or decline.
 * All of this is settled before the turn runs, so the simulation only ever sees final commands.
 * @module
 */

import type { TurnCommand } from "#app/battle";
import { globalScene } from "#app/global-scene";
import type { CoopTurnMessage } from "#coop/coop-input-broker";
import type { CoopRole, CoopTurnCommandData, CoopTurnCommandPayload } from "#coop/coop-protocol";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { Command } from "#enums/command";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";

/** What this client knows about the inputs of the current turn. */
interface CoopTurnState {
  session: CoopSession;
  wave: number;
  turn: number;
  /** Field slots that needed a player's input this turn (local or partner) */
  inputSlots: Set<number>;
  /** Local slots whose final command was sent */
  sent: Set<number>;
}

let turnState: CoopTurnState | null = null;
let fleeListenerSession: CoopSession | null = null;

function getTurnState(session: CoopSession): CoopTurnState {
  const { waveIndex: wave, turn } = globalScene.currentBattle;
  if (turnState?.session !== session || turnState.wave !== wave || turnState.turn !== turn) {
    turnState = { session, wave, turn, inputSlots: new Set(), sent: new Set() };
  }
  return turnState;
}

/** The owner of the pokemon in a player field slot. Pokemon without a recorded owner count as the host's. */
export function getFieldSlotOwner(session: CoopSession, fieldIndex: number): CoopRole {
  const pokemon = globalScene.getPlayerField()[fieldIndex];
  return (pokemon && session.ownership.get(pokemon.id)) ?? "host";
}

function isLocalSlot(session: CoopSession, fieldIndex: number): boolean {
  return getFieldSlotOwner(session, fieldIndex) === session.localRole;
}

/** A command as it travels: plain JSON. */
export function serializeTurnCommand(command: TurnCommand): CoopTurnCommandData {
  return JSON.parse(JSON.stringify(command));
}

function deserializeTurnCommand(data: CoopTurnCommandData): TurnCommand {
  return structuredClone(data) as TurnCommand;
}

/**
 * Whether the ally slot keeps its own command when a slot throws a ball or runs.
 * In solo the other slot is skipped; in co-op it belongs to the other player.
 */
export function coopKeepsAllyCommand(): boolean {
  return coopSession !== null;
}

/** Whether going back from field slot 1 to slot 0 is blocked: in co-op, slot 0 is not this player's to redo. */
export function coopBlocksCommandCancel(): boolean {
  return coopSession !== null;
}

/**
 * Move a partner slot's `CommandPhase` behind the local slot's, so the local player inputs first.
 * Once no local slot is left to input, send the local commands.
 * Call first thing in `CommandPhase.start`.
 * @returns Whether the phase was moved (and ended); the caller must stop
 */
export function deferCoopRemoteCommand(phase: CommandPhase): boolean {
  const session = coopSession;
  if (!session || isLocalSlot(session, phase.getFieldIndex())) {
    return false;
  }
  const { phaseManager } = globalScene;
  const isLaterLocal = (p: CommandPhase) =>
    p.getFieldIndex() !== phase.getFieldIndex() && isLocalSlot(session, p.getFieldIndex());
  let localIndex: number | undefined;
  phaseManager.hasPhaseOfType("CommandPhase", p => {
    if (localIndex === undefined && isLaterLocal(p)) {
      localIndex = p.getFieldIndex();
    }
    return false;
  });
  if (localIndex === undefined) {
    // Every local slot is final by now: let the partner have them, even if this slot turns out to be automatic.
    flushCoopTurnCommands();
    return false;
  }
  const local = localIndex;
  phaseManager.tryRemovePhase("CommandPhase", p => p.getFieldIndex() === local);
  phaseManager.unshiftNew("CommandPhase", local);
  phaseManager.unshiftNew("CommandPhase", phase.getFieldIndex());
  phase.end();
  return true;
}

/**
 * Send the final commands of the local slots that have not been sent yet.
 * Called when a partner slot starts waiting and when the turn starts (in case no partner slot waits).
 */
export function flushCoopTurnCommands(): void {
  const session = coopSession;
  if (!session) {
    return;
  }
  const state = getTurnState(session);
  const { turnCommands, preTurnCommands } = globalScene.currentBattle;
  for (const fieldIndex of state.inputSlots) {
    const turnCommand = turnCommands[fieldIndex];
    if (state.sent.has(fieldIndex) || !isLocalSlot(session, fieldIndex) || !turnCommand) {
      continue;
    }
    const preTurnCommand = preTurnCommands[fieldIndex];
    const command: CoopTurnCommandPayload = {
      fieldIndex,
      turnCommand: serializeTurnCommand(turnCommand),
      preTurnCommand: preTurnCommand ? serializeTurnCommand(preTurnCommand) : null,
    };
    session.inputs.send({ t: "turnCommand", wave: state.wave, turn: state.turn, command });
    state.sent.add(fieldIndex);
  }
}

/**
 * Take over a `CommandPhase` at the point it would show the command UI.
 * - A partner slot waits for the partner's command and applies it.
 * - A local slot shows the partner's flee proposal first, if one is waiting.
 * @returns Whether co-op took over (the caller must not show its UI)
 */
export function takeOverCoopCommandInput(phase: CommandPhase): boolean {
  const session = coopSession;
  if (!session) {
    return false;
  }
  ensureFleeListener(session);
  const fieldIndex = phase.getFieldIndex();
  const state = getTurnState(session);
  state.inputSlots.add(fieldIndex);
  if (isLocalSlot(session, fieldIndex)) {
    const proposal = findFleeProposal(session, state);
    if (proposal) {
      showFleeProposal(session, phase);
      return true;
    }
    return false;
  }
  flushCoopTurnCommands();
  awaitPartnerCommand(session, phase, state);
  return true;
}

/** The local slot that input a RUN this turn, if any. */
function findLocalRun(session: CoopSession, state: CoopTurnState): number | undefined {
  const { turnCommands } = globalScene.currentBattle;
  return [...state.inputSlots].find(
    i => isLocalSlot(session, i) && turnCommands[i]?.command === Command.RUN && !turnCommands[i]?.skip,
  );
}

function hasLocalInput(session: CoopSession, state: CoopTurnState): boolean {
  return [...state.inputSlots].some(i => isLocalSlot(session, i));
}

function isPartnerRun(message: CoopTurnMessage): boolean {
  return message.t === "turnCommand" && message.command.turnCommand.command === Command.RUN;
}

function showWaitingText(session: CoopSession, state: CoopTurnState): void {
  const ui = globalScene.ui;
  ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText(findLocalRun(session, state) === undefined ? "waitingForCommand" : "waitingForFleeAnswer"));
}

function awaitPartnerCommand(session: CoopSession, phase: CommandPhase, state: CoopTurnState): void {
  const fieldIndex = phase.getFieldIndex();
  showWaitingText(session, state);
  const isStale = () => coopSession !== session || globalScene.phaseManager.getCurrentPhase() !== phase;

  const next = (): void => {
    session.inputs
      .waitTurnMessage(
        state.wave,
        state.turn,
        m => m.t === "confirm" || (m.t === "turnCommand" && m.command.fieldIndex === fieldIndex),
      )
      .then(message => {
        if (isStale()) {
          return;
        }
        const localRun = findLocalRun(session, state);
        if (message.t === "confirm") {
          // The partner declined the local flee proposal.
          if (localRun === undefined) {
            next();
          } else {
            redoLocalCommand(phase, localRun, "fleeDeclined");
          }
          return;
        }
        if (isPartnerRun(message) && localRun === undefined && hasLocalInput(session, state)) {
          // The partner proposed to flee, but the local player chose something else: the proposal lapses.
          next();
          return;
        }
        if (!isPartnerRun(message) && localRun !== undefined) {
          // The partner chose something else: the local flee proposal lapses. Their command still counts.
          session.inputs.putBackTurnMessage(message);
          redoLocalCommand(phase, localRun, "fleeDeclined");
          return;
        }
        applyPartnerCommand(message.command);
        globalScene.ui.clearText();
        if (localRun !== undefined) {
          // Both run: one attempt for the team.
          const { turnCommands } = globalScene.currentBattle;
          turnCommands[Math.max(localRun, fieldIndex)]!.skip = true;
        }
        phase.end();
      });
  };
  next();
}

function applyPartnerCommand(command: CoopTurnCommandPayload): void {
  const { turnCommands, preTurnCommands } = globalScene.currentBattle;
  turnCommands[command.fieldIndex] = deserializeTurnCommand(command.turnCommand);
  preTurnCommands[command.fieldIndex] = command.preTurnCommand ? deserializeTurnCommand(command.preTurnCommand) : null;
}

/** Send the local player back to choosing a slot's command, then wait for the partner again. */
function redoLocalCommand(phase: CommandPhase, localIndex: number, reason: "fleeDeclined"): void {
  const session = coopSession!;
  const state = getTurnState(session);
  const { currentBattle, phaseManager } = globalScene;
  currentBattle.turnCommands[localIndex] = null;
  currentBattle.preTurnCommands[localIndex] = null;
  state.sent.delete(localIndex);
  phaseManager.queueMessage(coopText(reason));
  phaseManager.unshiftNew("CommandPhase", localIndex);
  phaseManager.unshiftNew("CommandPhase", phase.getFieldIndex());
  phase.end();
}

function findFleeProposal(session: CoopSession, state: CoopTurnState): CoopTurnMessage | undefined {
  return session.inputs
    .peekTurnMessages(state.wave, state.turn)
    .find(m => isPartnerRun(m) && !isLocalSlot(session, (m as { command: CoopTurnCommandPayload }).command.fieldIndex));
}

/** Show a flee proposal that arrives while the local player is choosing a command. */
function ensureFleeListener(session: CoopSession): void {
  if (fleeListenerSession === session) {
    return;
  }
  fleeListenerSession = session;
  session.inputs.onTurnMessage(message => {
    if (coopSession !== session || !isPartnerRun(message)) {
      return;
    }
    const phase = globalScene.phaseManager.getCurrentPhase();
    if (!phase.is("CommandPhase") || !isLocalSlot(session, phase.getFieldIndex())) {
      return;
    }
    const state = getTurnState(session);
    if (
      message.wave !== state.wave
      || message.turn !== state.turn
      || !state.inputSlots.has(phase.getFieldIndex())
      || globalScene.currentBattle.turnCommands[phase.getFieldIndex()]
      || !findFleeProposal(session, state)
    ) {
      return;
    }
    showFleeProposal(session, phase);
  });
}

/** Ask the local player whether to flee with the partner. */
function showFleeProposal(session: CoopSession, phase: CommandPhase): void {
  const ui = globalScene.ui;
  const fieldIndex = phase.getFieldIndex();
  ui.setMode(UiMode.MESSAGE);
  ui.showText(
    coopText("fleeProposal"),
    null,
    () => {
      ui.setMode(UiMode.CONFIRM, {
        yesHandler: () => {
          ui.setMode(UiMode.MESSAGE);
          if (!phase.handleCommand(Command.RUN, 0)) {
            // Cannot flee (trapped and the like): the message the phase shows leads back to the command UI.
            return;
          }
        },
        noHandler: () => {
          const state = getTurnState(session);
          const proposal = session.inputs.takeTurnMessage(
            state.wave,
            state.turn,
            m => m === findFleeProposal(session, state),
          );
          if (proposal) {
            session.inputs.send({ t: "confirm", kind: "flee", wave: state.wave, turn: state.turn, accepted: false });
          }
          ui.setMode(UiMode.COMMAND, fieldIndex);
        },
      });
    },
    null,
    true,
  );
}
