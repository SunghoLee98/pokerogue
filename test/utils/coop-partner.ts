/**
 * A scripted co-op partner for tests: the other end of a loopback connection, played by the test.
 *
 * One process can only run one game, so the partner's client does not exist. The test sends what the partner's
 * client would send (its battle commands, flee answers and choices) and reads what the local client sent.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { CoopInputBroker } from "#coop/coop-input-broker";
import type { CoopDecision, CoopMessage, CoopRole, CoopTurnCommandPayload } from "#coop/coop-protocol";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair, type LoopbackPair } from "#coop/loopback-transport";
import { ReliableCoopTransport } from "#coop/reliable-coop-transport";
import type { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import type { MoveId } from "#enums/move-id";
import { MoveUseMode } from "#enums/move-use-mode";
import type { PokeballType } from "#enums/pokeball";
import { getMoveTargets } from "#moves/move-utils";
import { vi } from "vitest";

/**
 * Wait for a condition with room for a loaded machine: the default one second is too short when the whole suite runs.
 */
export function waitForCoop<T>(condition: () => T, timeout = 10_000): Promise<T> {
  return vi.waitUntil(condition, { timeout });
}

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
      // A spread move still goes through target selection, which confirms all of its targets.
      ...(moveTargets.targets.length > 1 && moveTargets.multiple && { targets: moveTargets.targets }),
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

/** Answers the local client's waits for the partner's wave start "switch?" choice: by default the last partner made. */
let waveStartResponder: ((seq: number, fieldIndex: number) => void) | null = null;

/**
 * Answer the local client's waits for the partner's wave start switch choice as soon as it starts waiting, so tests
 * need not know the decision number. The spy is restored after each test; each new partner installs it again.
 */
function watchWaveStartSwitchWaits(responder: (seq: number, fieldIndex: number) => void): void {
  waveStartResponder = responder;
  const proto = CoopInputBroker.prototype;
  if (vi.isMockFunction(proto.waitDecision)) {
    return;
  }
  const original = proto.waitDecision;
  vi.spyOn(proto, "waitDecision").mockImplementation(function (this: CoopInputBroker, seq: number) {
    const result = original.call(this, seq);
    const phase = globalScene.phaseManager.getCurrentPhase();
    if (phase?.is("CheckSwitchPhase")) {
      waveStartResponder?.(seq, (phase as unknown as { fieldIndex: number }).fieldIndex);
    }
    return result;
  });
}

/**
 * Play the partner's part of the wave start "switch?" question over a connection the test drives itself: whenever the
 * local client waits for the partner's answer, the partner stays.
 * @param partnerTransport - The partner's end of the connection
 */
export function answerWaveStartSwitches(partnerTransport: CoopTransport): void {
  watchWaveStartSwitchWaits(seq => {
    const decision: CoopDecision = { kind: "waveStartSwitch", seq, slotIndex: -1 };
    partnerTransport.send({
      t: "choice",
      kind: decision.kind,
      wave: globalScene.currentBattle.waveIndex,
      payload: decision,
    });
  });
}

export class CoopTestPartner {
  /** The local client's end of the connection, to start the co-op run with */
  readonly localTransport: CoopTransport;
  /** Everything the local client sent */
  readonly received: CoopMessage[] = [];
  private readonly transport: CoopTransport;
  private readonly listeners = new Set<(message: CoopMessage) => void>();

  private readonly pair: LoopbackPair;

  /**
   * The party slot the partner sends out when asked at the start of a wave whether to switch its pokemon in
   * `fieldIndex`, `null` to keep it. Default: keep it (as a partner playing with the "Set" battle style would).
   */
  waveStartSwitch: (wave: number, fieldIndex: number) => number | null = () => null;

  /**
   * Send the partner's answer to the wave start "switch?" question while the local client waits for it.
   * Replaceable, for example to send a recorded answer instead.
   */
  answerWaveStartSwitch = (seq: number, fieldIndex: number): void => {
    const slot = this.waveStartSwitch(globalScene.currentBattle.waveIndex, fieldIndex);
    this.sendDecision({ kind: "waveStartSwitch", seq, slotIndex: slot ?? -1 });
  };

  /**
   * @param localRole - The role of the client under test; the partner plays the other one
   * @param reliable - Wrap both ends the way a real connection is wrapped, resending what a dropped connection lost
   */
  constructor(localRole: CoopRole, { reliable = false }: { reliable?: boolean } = {}) {
    const pair = createLoopbackPair();
    this.pair = pair;
    const local = pair[localRole];
    const remote = pair[localRole === "host" ? "guest" : "host"];
    this.localTransport = reliable ? new ReliableCoopTransport(local) : local;
    this.transport = reliable ? new ReliableCoopTransport(remote) : remote;
    watchWaveStartSwitchWaits((seq, fieldIndex) => this.answerWaveStartSwitch(seq, fieldIndex));
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

  /** Break the connection: both ends report `"reconnecting"` and messages are lost until {@linkcode restore}. */
  drop(): void {
    this.pair.drop();
  }

  /** Reconnect both ends. */
  restore(): void {
    this.pair.restore();
  }

  /** The partner's client goes away for good. */
  close(): void {
    this.transport.close();
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

  /**
   * Play the host's part on the reward screen for a guest client: number each of its requests in arrival order and
   * send them back, as the host does.
   * @param firstSeq - The number to give the first request
   */
  orderRewards(firstSeq = 0): void {
    let seq = firstSeq;
    this.onReceive(message => {
      if (message.t === "reward" && message.seq === undefined) {
        this.send({ ...message, seq: seq++ });
      }
    });
  }

  /** The battle commands the local client sent. */
  get sentCommands(): Extract<CoopMessage, { t: "turnCommand" }>[] {
    return this.received.filter((m): m is Extract<CoopMessage, { t: "turnCommand" }> => m.t === "turnCommand");
  }
}
