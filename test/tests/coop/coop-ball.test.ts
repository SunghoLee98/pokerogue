import { withCoopBallTarget } from "#coop/coop-ball";
import { getCaptureSimData } from "#coop/coop-capture";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import * as Pokeball from "#data/pokeball";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeBallCommand, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { TargetSelectUiHandler } from "#ui/target-select-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number, caughtSpecies: number[] = []): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies,
  eggMoves: {},
  unlocks: [],
});

/** The guest has caught far more species than the host: their dex multipliers differ. */
const HOST_CAUGHT = Array.from({ length: 50 }, (_, i) => i + 1);
const GUEST_CAUGHT = Array.from({ length: 450 }, (_, i) => i + 1);

const startInfo = (): CoopStartInfo => ({
  seed: "coop-ball",
  accounts: { host: snapshot(1, HOST_CAUGHT), guest: snapshot(2, GUEST_CAUGHT) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

describe("co-op balls", () => {
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
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH, MoveId.SCRATCH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    return partner;
  }

  const commandPhase = () => game.scene.phaseManager.getCurrentPhase() as CommandPhase;

  /** Throw a ball from the local slot at a target, at the next command prompt. */
  function throwBall(ball: PokeballType, target: BattlerIndex): void {
    game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
      withCoopBallTarget(target, () => commandPhase().handleCommand(Command.BALL, ball));
    });
  }

  it("keeps the partner's command when throwing a ball", async () => {
    const partner = await start("host");
    game.scene.pokeballCounts[PokeballType.POKEBALL] = 5;
    throwBall(PokeballType.POKEBALL, BattlerIndex.ENEMY);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SCRATCH, BattlerIndex.ENEMY_2));
    await game.phaseInterceptor.to("TurnStartPhase", false);

    const { turnCommands } = game.scene.currentBattle;
    expect(turnCommands[BattlerIndex.PLAYER]).toMatchObject({ command: Command.BALL, targets: [BattlerIndex.ENEMY] });
    expect(turnCommands[BattlerIndex.PLAYER_2]?.skip).toBeFalsy();

    await game.toEndOfTurn();
    expect(game.scene.getPlayerField()[1].getLastXMoves()[0].move).toBe(MoveId.SCRATCH);
    expect(game.scene.pokeballCounts[PokeballType.POKEBALL]).toBe(4);
  });

  it("asks for the target when two enemies are out", async () => {
    await start("host");
    game.scene.pokeballCounts[PokeballType.POKEBALL] = 5;
    const phase = commandPhase();

    expect(phase.handleCommand(Command.BALL, PokeballType.POKEBALL)).toBe(false);
    expect(game.scene.ui.mode).toBe(UiMode.TARGET_SELECT);
    const handler = game.scene.ui.getHandler() as TargetSelectUiHandler;
    handler.setCursor(BattlerIndex.ENEMY_2);
    handler.processInput(Button.ACTION);

    expect(game.scene.currentBattle.turnCommands[BattlerIndex.PLAYER]).toMatchObject({
      command: Command.BALL,
      cursor: PokeballType.POKEBALL,
      targets: [BattlerIndex.ENEMY_2],
    });
  });

  it("goes back to the balls when the target choice is cancelled", async () => {
    await start("host");
    game.scene.pokeballCounts[PokeballType.POKEBALL] = 5;

    commandPhase().handleCommand(Command.BALL, PokeballType.POKEBALL);
    (game.scene.ui.getHandler() as TargetSelectUiHandler).processInput(Button.CANCEL);

    expect(game.scene.ui.mode).toBe(UiMode.BALL);
    expect(game.scene.currentBattle.turnCommands[BattlerIndex.PLAYER]).toBeNull();
  });

  it("does not throw a second ball at a caught target", async () => {
    const partner = await start("host");
    game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 2;
    const target = game.scene.getEnemyField()[0];
    throwBall(PokeballType.MASTER_BALL, BattlerIndex.ENEMY);
    partner.sendCommand(synthesizeBallCommand(1, PokeballType.MASTER_BALL, BattlerIndex.ENEMY));
    await game.toEndOfTurn();

    // The host's ball (field slot 0) acts first and catches; the guest's ball stays in the bag.
    expect(game.scene.pokeballCounts[PokeballType.MASTER_BALL]).toBe(1);
    expect(game.scene.getPlayerParty()).toHaveLength(3);
    expect(game.scene.getPlayerParty()[2].species.speciesId).toBe(target.species.speciesId);
  });

  it("does not throw a ball the team has run out of", async () => {
    const partner = await start("host");
    game.scene.pokeballCounts[PokeballType.POKEBALL] = 1;
    const [first, second] = game.scene.getEnemyField();
    first.hp = 1;
    second.hp = 1;
    throwBall(PokeballType.POKEBALL, BattlerIndex.ENEMY);
    partner.sendCommand(synthesizeBallCommand(1, PokeballType.POKEBALL, BattlerIndex.ENEMY_2));
    const attempts = vi.spyOn(Pokeball, "getCriticalCaptureChance");
    await game.toEndOfTurn();

    expect(attempts).toHaveBeenCalledTimes(1);
    expect(game.scene.pokeballCounts[PokeballType.POKEBALL]).toBe(0);
  });

  it("uses the thrower's dex for critical captures", async () => {
    const partner = await start("host");
    game.scene.pokeballCounts[PokeballType.POKEBALL] = 5;
    const chance = vi.spyOn(Pokeball, "getCriticalCaptureChance");
    throwBall(PokeballType.POKEBALL, BattlerIndex.ENEMY);
    partner.sendCommand(synthesizeBallCommand(1, PokeballType.POKEBALL, BattlerIndex.ENEMY_2));
    await game.toEndOfTurn();

    const dexCounts = chance.mock.calls.map(([, account]) => account?.getCaughtSpeciesCount());
    expect(dexCounts).toEqual([HOST_CAUGHT.length, GUEST_CAUGHT.length]);
  });

  it("reads the capture dex of the thrower's owner", async () => {
    await start("guest");
    const [host, guest] = game.scene.getPlayerField();
    expect(coopSession?.ownership.get(guest.id)).toBe("guest");
    expect(getCaptureSimData(host.id).getCaughtSpeciesCount()).toBe(HOST_CAUGHT.length);
    expect(getCaptureSimData(guest.id).getCaughtSpeciesCount()).toBe(GUEST_CAUGHT.length);
  });

  it("reads the local dex in solo", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const local = game.scene.gameData.getSpeciesCount(d => !!d.caughtAttr);
    expect(getCaptureSimData(game.scene.getPlayerParty()[0].id).getCaughtSpeciesCount()).toBe(local);
  });
});
