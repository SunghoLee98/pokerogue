import { speciesDataRegistry } from "#app/global-species-data-registry";
import { activeOverrides } from "#app/overrides";
import { COOP_FINAL_BOSS_STAT_MULTIPLIER } from "#coop/coop-battle-rules";
import { findFirstDesync } from "#coop/coop-desync";
import { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { GameManager } from "#test/framework/game-manager";
import {
  type CoopReplayAction,
  type CoopReplayCommandFn,
  type CoopReplayLog,
  type CoopReplayOptions,
  type CoopTestAccount,
  createFreshGameManager,
  inputsBy,
  runCoopReplay,
} from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hostAccount: CoopTestAccount = {
  trainerId: 12345,
  secretId: 54321,
  unlocks: [],
  caughtSpecies: [],
  eggMoves: {},
};

/**
 * The guest's account differs from the host's in every value the simulation reads.
 * Its large dex gives it critical captures the host's dex does not.
 */
const guestAccount: CoopTestAccount = {
  trainerId: 777,
  secretId: 888,
  unlocks: [],
  caughtSpecies: Array.from({ length: 450 }, (_, i) => (i + 1) as SpeciesId),
  eggMoves: { [SpeciesId.CHARMANDER]: 0b1111 },
};

/** One scenario: what each player does, and what else to set up. */
interface Scenario {
  host: CoopReplayCommandFn;
  guest: CoopReplayCommandFn;
  setup?: (game: GameManager) => void;
  options?: Partial<CoopReplayOptions>;
}

/** Attack the first living enemy, preferring the given slot. */
function attack(game: () => GameManager, moveId: MoveId, preferred: BattlerIndex.ENEMY | BattlerIndex.ENEMY_2) {
  return (() => {
    const [first, second] = game().scene.getEnemyField();
    const slots = preferred === BattlerIndex.ENEMY ? [first, second] : [second, first];
    const target = slots.find(p => p && !p.isFainted()) ?? first;
    return { kind: "move" as const, moveId, target: target.getBattlerIndex() };
  }) satisfies CoopReplayCommandFn;
}

/** On the first turn of the run, `first`; afterwards, `then`. */
function firstTurn(first: CoopReplayAction[], then: CoopReplayCommandFn): CoopReplayCommandFn {
  return (wave, turn) => (wave === 1 && turn === 1 ? first : then(wave, turn));
}

/** Plenty of balls for both players. */
function stockBalls(game: GameManager): void {
  game.scene.pokeballCounts[PokeballType.POKEBALL] = 10;
  game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 4;
}

describe("co-op battle replay", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  afterEach(() => {
    game.phaseInterceptor.clearLogs();
  });

  function prepare(scenario: Scenario): void {
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH, MoveId.MEMENTO, MoveId.SPLASH]);
    scenario.setup?.(game);
  }

  /**
   * Record the scenario as the host (the guest's inputs made up from its script), then replay it as the guest with
   * the guest's own account (the host's inputs taken from the recording).
   */
  async function recordAndReplay(scenario: Scenario): Promise<{ hostLog: CoopReplayLog; guestLog: CoopReplayLog }> {
    const common = {
      accounts: { host: hostAccount, guest: guestAccount },
      species: [SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER] as [SpeciesId, SpeciesId],
      waves: 2,
      ...scenario.options,
    };
    prepare(scenario);
    const hostLog = await runCoopReplay(game, {
      ...common,
      role: "host",
      localCommand: scenario.host,
      remote: { command: scenario.guest },
    });

    game = createFreshGameManager(phaserGame);
    prepare(scenario);
    const guestLog = await runCoopReplay(game, {
      ...common,
      role: "guest",
      localCommand: scenario.guest,
      remote: { log: hostLog },
    });
    return { hostLog, guestLog };
  }

  function expectInSync({ hostLog, guestLog }: { hostLog: CoopReplayLog; guestLog: CoopReplayLog }): void {
    expect(findFirstDesync(hostLog.checksums, guestLog.checksums)).toBeNull();
    // The guest's real inputs are what the recording made up for it, and it replayed the host's exactly.
    expect(inputsBy(guestLog, "guest")).toEqual(inputsBy(hostLog, "guest"));
    expect(inputsBy(guestLog, "host")).toEqual(inputsBy(hostLog, "host"));
  }

  it("both players throw balls", async () => {
    const logs = await recordAndReplay({
      host: firstTurn(
        [{ kind: "ball", ball: PokeballType.POKEBALL, target: BattlerIndex.ENEMY }],
        attack(() => game, MoveId.TACKLE, BattlerIndex.ENEMY),
      ),
      guest: firstTurn(
        [{ kind: "ball", ball: PokeballType.POKEBALL, target: BattlerIndex.ENEMY_2 }],
        attack(() => game, MoveId.SCRATCH, BattlerIndex.ENEMY_2),
      ),
      options: { onStart: stockBalls },
    });

    expectInSync(logs);
    const firstTurnCommands = logs.hostLog.inputs.filter(i => i.wave === 1 && i.turn === 1);
    expect(firstTurnCommands.map(i => i.message.t === "turnCommand" && i.message.command.turnCommand.command)).toEqual([
      Command.BALL,
      Command.BALL,
    ]);
  });

  it("one player throws a ball while the other attacks", async () => {
    const logs = await recordAndReplay({
      host: attack(() => game, MoveId.TACKLE, BattlerIndex.ENEMY_2),
      guest: firstTurn(
        [{ kind: "ball", ball: PokeballType.POKEBALL, target: BattlerIndex.ENEMY }],
        attack(() => game, MoveId.SCRATCH, BattlerIndex.ENEMY),
      ),
      options: { onStart: stockBalls },
    });

    expectInSync(logs);
  });

  it("both players throw at the same target", async () => {
    const logs = await recordAndReplay({
      host: firstTurn(
        [{ kind: "ball", ball: PokeballType.MASTER_BALL, target: BattlerIndex.ENEMY }],
        attack(() => game, MoveId.TACKLE, BattlerIndex.ENEMY_2),
      ),
      guest: firstTurn(
        [{ kind: "ball", ball: PokeballType.MASTER_BALL, target: BattlerIndex.ENEMY }],
        attack(() => game, MoveId.SCRATCH, BattlerIndex.ENEMY_2),
      ),
      options: { onStart: stockBalls },
    });

    expectInSync(logs);
    // The host's ball caught the target; the guest's was not thrown.
    const afterFirstTurn = logs.hostLog.states[1];
    expect(afterFirstTurn.playerParty).toHaveLength(3);
    expect(afterFirstTurn.playerParty[2].owner).toBe("host");
  });

  it("the partner accepts a flee proposal", async () => {
    const logs = await recordAndReplay({
      host: () => ({ kind: "run" }),
      guest: () => ({ kind: "fleeAnswer", accept: true }),
      setup: () => vi.spyOn(activeOverrides, "RUN_SUCCESS_OVERRIDE", "get").mockReturnValue(true),
    });

    expectInSync(logs);
    expect(new Set(logs.hostLog.checksums.map(c => c.wave)).size).toBe(2);
  });

  it("the partner declines a flee proposal", async () => {
    const logs = await recordAndReplay({
      host: firstTurn(
        [{ kind: "run" }, { kind: "move", moveId: MoveId.TACKLE, target: BattlerIndex.ENEMY }],
        attack(() => game, MoveId.TACKLE, BattlerIndex.ENEMY),
      ),
      guest: firstTurn(
        [
          { kind: "fleeAnswer", accept: false },
          { kind: "move", moveId: MoveId.SCRATCH, target: BattlerIndex.ENEMY_2 },
        ],
        attack(() => game, MoveId.SCRATCH, BattlerIndex.ENEMY_2),
      ),
    });

    expectInSync(logs);
    const declines = logs.guestLog.inputs.filter(i => i.message.t === "confirm");
    expect(declines).toHaveLength(1);
  });

  it("one player is wiped out and the partner fights on", async () => {
    const logs = await recordAndReplay({
      host: attack(() => game, MoveId.TACKLE, BattlerIndex.ENEMY),
      // The guest's only pokemon faints on the first turn; the guest has no input after that.
      guest: firstTurn([{ kind: "move", moveId: MoveId.MEMENTO, target: BattlerIndex.ENEMY_2 }], () => []),
    });

    expectInSync(logs);
    const secondWave = logs.hostLog.states.find(state => state.wave === 2);
    expect(secondWave?.playerField).toHaveLength(2);
    const [hostSlot, guestSlot] = secondWave!.playerParty;
    expect(hostSlot.hp).toBeGreaterThan(0);
    expect(guestSlot.hp).toBe(0);
  });

  it("the classic final boss is fought 2v1 with boosted phase one stats", async () => {
    const logs = await recordAndReplay({
      host: attack(() => game, MoveId.TACKLE, BattlerIndex.ENEMY),
      guest: attack(() => game, MoveId.SCRATCH, BattlerIndex.ENEMY),
      setup: game => game.override.startingWave(200).startingBiome(BiomeId.END),
      options: { waves: 1, turns: 2 },
    });

    expectInSync(logs);
    const [eternatus] = logs.hostLog.states[0].enemyParty;
    expect(logs.hostLog.states[0].enemyParty).toHaveLength(1);
    expect(eternatus.speciesId).toBe(SpeciesId.ETERNATUS);
    const species = speciesDataRegistry.getSpecies(SpeciesId.ETERNATUS);
    const soloHp = Math.floor(((2 * species.baseStats[Stat.HP] + 31) * eternatus.level) / 100) + eternatus.level + 10;
    expect(eternatus.hp).toBe(Math.floor(soloHp * COOP_FINAL_BOSS_STAT_MULTIPLIER));
  });

  it("attacks: the guest replay matches the host", async () => {
    const logs = await recordAndReplay({
      host: attack(() => game, MoveId.TACKLE, BattlerIndex.ENEMY),
      guest: attack(() => game, MoveId.SCRATCH, BattlerIndex.ENEMY_2),
    });

    expectInSync(logs);
    expect(new Set(logs.hostLog.checksums.map(c => c.wave)).size).toBe(2);
    expect(inputsBy(logs.hostLog, "host").length).toBeGreaterThan(0);
    expect(inputsBy(logs.hostLog, "guest").length).toBe(inputsBy(logs.hostLog, "host").length);
  });
});
