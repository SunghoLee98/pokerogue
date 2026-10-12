import { activeOverrides } from "#app/overrides";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand, synthesizeRunCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-flee",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

describe("co-op fleeing", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingWave(3)
      .startingLevel(100)
      .enemyLevel(100)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.TACKLE, MoveId.SCRATCH, MoveId.MEMENTO]);
    vi.spyOn(activeOverrides, "RUN_SUCCESS_OVERRIDE", "get").mockReturnValue(true);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    game.phaseInterceptor.clearLogs();
    return partner;
  }

  const commandPhase = () => game.scene.phaseManager.getCurrentPhase() as CommandPhase;
  const runAttempts = () => game.phaseInterceptor.phaseLog.filter(p => p === "AttemptRunPhase").length;

  function run(): void {
    game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
      commandPhase().handleCommand(Command.RUN, 0);
    });
  }

  function answerFlee(accept: boolean): void {
    game.onNextPrompt("CommandPhase", UiMode.CONFIRM, () => {
      const handler = game.scene.ui.getHandler() as ConfirmUiHandler;
      handler.setCursor(accept ? 0 : 1);
      handler.processInput(Button.ACTION);
    });
  }

  it("flees once when both players run", async () => {
    const partner = await start("host");
    run();
    const turnStart = game.phaseInterceptor.to("TurnStartPhase", false);
    await vi.waitUntil(() => partner.sentCommands.length > 0);
    // The guest agrees to the host's proposal.
    partner.sendCommand(synthesizeRunCommand(1));
    await turnStart;

    const { turnCommands } = game.scene.currentBattle;
    expect(turnCommands[BattlerIndex.PLAYER]).toMatchObject({ command: Command.RUN });
    expect(turnCommands[BattlerIndex.PLAYER]?.skip).toBeFalsy();
    expect(turnCommands[BattlerIndex.PLAYER_2]).toMatchObject({ command: Command.RUN, skip: true });

    await game.toEndOfTurn();
    expect(runAttempts()).toBe(1);
    expect(game.scene.currentBattle.successfulRun).toBe(true);
  });

  it("shows the partner's flee proposal waiting at the start of the command", async () => {
    const partner = await start("guest");
    partner.sendCommand(synthesizeRunCommand(0));
    answerFlee(true);
    await game.toEndOfTurn();

    expect(partner.sentCommands.map(m => m.command)).toEqual([synthesizeRunCommand(1)]);
    expect(runAttempts()).toBe(1);
    expect(game.scene.currentBattle.successfulRun).toBe(true);
  });

  it("shows a flee proposal that arrives while choosing", async () => {
    const partner = await start("guest");
    await game.phaseInterceptor.to("CommandPhase");
    expect(game.scene.ui.mode).toBe(UiMode.COMMAND);

    partner.sendCommand(synthesizeRunCommand(0));
    await vi.waitUntil(() => game.scene.ui.mode === UiMode.CONFIRM);
    expect(commandPhase().getFieldIndex()).toBe(1);
  });

  it("sends the proposer back to choosing when the partner declines", async () => {
    const partner = await start("host");
    run();
    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    partner.declineFlee();
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SCRATCH, BattlerIndex.ENEMY_2));
    await game.toEndOfTurn();

    expect(partner.sentCommands.map(m => m.turn)).toEqual([1, 1]);
    expect(runAttempts()).toBe(0);
    expect(partner.sentCommands.map(m => m.command.turnCommand.command)).toEqual([Command.RUN, Command.FIGHT]);
    expect(game.scene.getPlayerField()[0].getLastXMoves()[0].move).toBe(MoveId.TACKLE);
    expect(game.scene.getPlayerField()[1].getLastXMoves()[0].move).toBe(MoveId.SCRATCH);
  });

  it("lets the partner decline and choose their own command", async () => {
    const partner = await start("guest");
    partner.sendCommand(synthesizeRunCommand(0));
    answerFlee(false);
    game.move.select(MoveId.SCRATCH, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY_2);
    const turnEnd = game.toEndOfTurn();
    await vi.waitUntil(() => partner.received.some(m => m.t === "confirm"));
    expect(partner.received.find(m => m.t === "confirm")).toEqual({
      t: "confirm",
      kind: "flee",
      wave: 3,
      turn: 1,
      accepted: false,
    });
    // The host chooses again after the refusal.
    partner.sendCommand(synthesizeMoveCommand(0, MoveId.TACKLE, BattlerIndex.ENEMY));
    await turnEnd;

    expect(runAttempts()).toBe(0);
    expect(game.scene.getPlayerField()[0].getLastXMoves()[0].move).toBe(MoveId.TACKLE);
  });

  it("drops the proposal when the partner chose something else", async () => {
    const partner = await start("host");
    run();
    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SCRATCH, BattlerIndex.ENEMY_2));
    await game.toEndOfTurn();

    expect(runAttempts()).toBe(0);
    expect(partner.sentCommands.map(m => m.command.turnCommand.command)).toEqual([Command.RUN, Command.FIGHT]);
    expect(game.scene.getPlayerField()[1].getLastXMoves()[0].move).toBe(MoveId.SCRATCH);
  });

  it("ignores a proposal that comes after the local command", async () => {
    const partner = await start("guest");
    game.move.select(MoveId.SCRATCH, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY_2);
    const turnEnd = game.toEndOfTurn();
    await vi.waitUntil(() => partner.sentCommands.length > 0);
    partner.sendCommand(synthesizeRunCommand(0));
    partner.sendCommand(synthesizeMoveCommand(0, MoveId.TACKLE, BattlerIndex.ENEMY));
    await turnEnd;

    expect(runAttempts()).toBe(0);
    expect(game.scene.getPlayerField()[0].getLastXMoves()[0].move).toBe(MoveId.TACKLE);
  });

  it("flees alone in support mode", async () => {
    const partner = await start("host");
    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.MEMENTO, BattlerIndex.ENEMY));
    await game.toNextTurn();
    expect(game.scene.getPlayerField()[1].isFainted()).toBe(true);

    run();
    await game.toEndOfTurn();
    expect(runAttempts()).toBe(1);
    expect(game.scene.currentBattle.successfulRun).toBe(true);
  });
});
