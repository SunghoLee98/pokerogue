import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
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
  seed: "coop-turn-commands",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

describe("co-op turn commands", () => {
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
      .startingLevel(100)
      .enemyLevel(100)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.TACKLE, MoveId.SCRATCH, MoveId.OUTRAGE]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    return partner;
  }

  function currentCommandPhase(): CommandPhase {
    const phase = game.scene.phaseManager.getCurrentPhase();
    expect(phase.is("CommandPhase")).toBe(true);
    return phase as CommandPhase;
  }

  it("lets the host command only field slot 0 and waits for the partner", async () => {
    const ui = game.scene.ui;
    const textLog: string[] = [];
    const showText = ui.showText.bind(ui);
    const clearText = ui.clearText.bind(ui);
    vi.spyOn(ui, "showText").mockImplementation((text, ...rest) => {
      textLog.push(text);
      return showText(text, ...rest);
    });
    vi.spyOn(ui, "clearText").mockImplementation(() => {
      textLog.push("");
      return clearText();
    });
    const partner = await start("host");
    expect(currentCommandPhase().getFieldIndex()).toBe(0);
    expect(game.scene.ui.mode).toBe(UiMode.COMMAND);

    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY_2);
    const turnStart = game.phaseInterceptor.to("TurnStartPhase", false);
    await vi.waitUntil(() => partner.sentCommands.length > 0);

    // The partner's slot waits without its command UI.
    expect(currentCommandPhase().getFieldIndex()).toBe(1);
    expect(game.scene.ui.mode).toBe(UiMode.MESSAGE);
    expect(partner.sentCommands).toEqual([
      { t: "turnCommand", wave: 1, turn: 1, command: synthesizeMoveCommand(0, MoveId.TACKLE, BattlerIndex.ENEMY_2) },
    ]);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(game.scene.phaseManager.getCurrentPhase().is("TurnStartPhase")).toBe(false);

    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SCRATCH, BattlerIndex.ENEMY));
    await turnStart;
    // The waiting text does not linger into the turn.
    const waitingShown = textLog.lastIndexOf(coopText("waitingForCommand"));
    expect(waitingShown).toBeGreaterThan(-1);
    expect(textLog.slice(waitingShown + 1)).toContain("");

    const { turnCommands } = game.scene.currentBattle;
    expect(turnCommands[BattlerIndex.PLAYER]?.targets).toEqual([BattlerIndex.ENEMY_2]);
    expect(turnCommands[BattlerIndex.PLAYER_2]).toMatchObject({
      command: Command.FIGHT,
      move: { move: MoveId.SCRATCH },
      targets: [BattlerIndex.ENEMY],
    });
    await game.toEndOfTurn();
    const [host, guest] = game.scene.getPlayerField();
    expect(host.getLastXMoves()[0].move).toBe(MoveId.TACKLE);
    expect(guest.getLastXMoves()[0].move).toBe(MoveId.SCRATCH);
    expect(partner.sentCommands).toHaveLength(1);
  });

  it("lets the guest command field slot 1 first", async () => {
    const partner = await start("guest");
    expect(currentCommandPhase().getFieldIndex()).toBe(1);

    game.move.select(MoveId.SCRATCH, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY);
    const turnStart = game.phaseInterceptor.to("TurnStartPhase", false);
    await vi.waitUntil(() => partner.sentCommands.length > 0);

    expect(currentCommandPhase().getFieldIndex()).toBe(0);
    expect(game.scene.ui.mode).toBe(UiMode.MESSAGE);
    expect(partner.sentCommands[0].command).toEqual(synthesizeMoveCommand(1, MoveId.SCRATCH, BattlerIndex.ENEMY));

    partner.sendCommand(synthesizeMoveCommand(0, MoveId.TACKLE, BattlerIndex.ENEMY_2));
    await turnStart;
    await game.toEndOfTurn();

    const [host, guest] = game.scene.getPlayerField();
    expect(host.getLastXMoves()[0].move).toBe(MoveId.TACKLE);
    expect(guest.getLastXMoves()[0].move).toBe(MoveId.SCRATCH);
  });

  it("neither sends nor waits for automatic commands", async () => {
    const partner = await start("host");
    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.OUTRAGE));
    await game.toNextTurn();

    // The guest's pokemon is locked into Outrage: no input for its slot this turn.
    game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
    await game.phaseInterceptor.to("TurnStartPhase", false);

    expect(game.scene.currentBattle.turnCommands[BattlerIndex.PLAYER_2]?.move?.move).toBe(MoveId.OUTRAGE);
    await vi.waitUntil(() => partner.sentCommands.length === 2);
    expect(partner.sentCommands[1]).toMatchObject({ turn: 2, command: { fieldIndex: 0 } });
  });

  it("does not go back to the partner's slot on cancel", async () => {
    await start("guest");
    const phase = currentCommandPhase();
    expect(phase.getFieldIndex()).toBe(1);
    await game.phaseInterceptor.to("CommandPhase");

    phase.cancel();

    expect(game.scene.phaseManager.getCurrentPhase()).toBe(phase);
    expect(game.scene.phaseManager.hasPhaseOfType("CommandPhase", p => p.getFieldIndex() === 1)).toBe(false);
  });
});
