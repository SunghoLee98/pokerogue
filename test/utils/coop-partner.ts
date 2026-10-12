/**
 * A scripted co-op partner for tests: the other end of a loopback connection, played by the test.
 *
 * One process can only run one game, so the partner's client does not exist. The test sends what the partner's
 * client would send (its battle commands, flee answers and choices) and reads what the local client sent.
 * @module
 */

import { globalScene } from "#app/global-scene";
import type { CoopDecision, CoopMessage, CoopRole, CoopTurnCommandPayload } from "#coop/coop-protocol";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import type { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import type { PokeballType } from "#enums/pokeball";
import { getMoveTargets } from "#moves/move-utils";

/** The same JSON round trip the wire applies. */
function asSent<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * The command a player's `CommandPhase` produces for a move, followed by target selection when it asks for one.
 * Mirrors `CommandPhase.handleFightCommand` and `SelectTargetPhase` for a move in the moveset.
 */
export function synthesizeMoveCommand(
  fieldIndex: number,
  moveId: MoveId,
  target?: BattlerIndex,
): CoopTurnCommandPayload {
  const pokemon = globalScene.getPlayerField()[fieldIndex];
  const cursor = pokemon.getMoveset().findIndex(m => m.moveId === moveId);
  if (cursor === -1) {
    throw new Error(`move ${moveId} is not in the moveset of field slot ${fieldIndex}`);
  }
  const moveTargets = getMoveTargets(pokemon, moveId);
  const picksTarget = moveTargets.targets.length > 1 && !moveTargets.multiple;
  return asSent({
    fieldIndex,
    turnCommand: {
      command: Command.FIGHT,
      cursor,
      move: { move: moveId, targets: picksTarget ? [] : moveTargets.targets, useMode: MoveUseMode.NORMAL },
      args: [MoveUseMode.NORMAL, undefined],
      ...(picksTarget && { targets: [target ?? moveTargets.targets[0]] }),
    },
    preTurnCommand: { command: Command.FIGHT, targets: [fieldIndex], skip: true },
  });
}

/** The command a player's `CommandPhase` produces for throwing a ball at a target. */
export function synthesizeBallCommand(
  fieldIndex: number,
  ball: PokeballType,
  target: BattlerIndex,
): CoopTurnCommandPayload {
  return asSent({
    fieldIndex,
    turnCommand: { command: Command.BALL, cursor: ball, targets: [target] },
    preTurnCommand: null,
  });
}

/** The command a player's `CommandPhase` produces for running away. */
export function synthesizeRunCommand(fieldIndex: number): CoopTurnCommandPayload {
  return asSent({ fieldIndex, turnCommand: { command: Command.RUN }, preTurnCommand: null });
}

export class CoopTestPartner {
  /** The local client's end of the connection, to start the co-op run with */
  readonly localTransport: CoopTransport;
  /** Everything the local client sent */
  readonly received: CoopMessage[] = [];
  private readonly transport: CoopTransport;
  private readonly listeners = new Set<(message: CoopMessage) => void>();

  /** @param localRole - The role of the client under test; the partner plays the other one */
  constructor(localRole: CoopRole) {
    const pair = createLoopbackPair();
    this.localTransport = pair[localRole];
    this.transport = pair[localRole === "host" ? "guest" : "host"];
    this.transport.onMessage(message => {
      this.received.push(message);
      for (const listener of [...this.listeners]) {
        listener(message);
      }
    });
  }

  /** Be told about each message the local client sends. */
  onReceive(listener: (message: CoopMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send(message: CoopMessage): void {
    this.transport.send(message);
  }

  /** Send the partner's command for the current turn. */
  sendCommand(
    command: CoopTurnCommandPayload,
    wave = globalScene.currentBattle.waveIndex,
    turn = globalScene.currentBattle.turn,
  ): void {
    this.send({ t: "turnCommand", wave, turn, command });
  }

  /** Decline the local player's flee proposal in the current turn. */
  declineFlee(wave = globalScene.currentBattle.waveIndex, turn = globalScene.currentBattle.turn): void {
    this.send({ t: "confirm", kind: "flee", wave, turn, accepted: false });
  }

  sendDecision(decision: CoopDecision, wave = globalScene.currentBattle.waveIndex): void {
    this.send({ t: "choice", kind: decision.kind, wave, payload: decision });
  }

  /** The battle commands the local client sent. */
  get sentCommands(): Extract<CoopMessage, { t: "turnCommand" }>[] {
    return this.received.filter((m): m is Extract<CoopMessage, { t: "turnCommand" }> => m.t === "turnCommand");
  }
}
