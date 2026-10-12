import { findFirstDesync } from "#coop/coop-desync";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import {
  type CoopReplayCommandFn,
  type CoopReplayLog,
  type CoopReplayOptions,
  type CoopTestAccount,
  createFreshGameManager,
  inputsBy,
  runCoopReplay,
} from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const hostAccount: CoopTestAccount = {
  trainerId: 12345,
  secretId: 54321,
  unlocks: [],
  caughtSpecies: [],
  eggMoves: {},
};

/** The guest's account differs from the host's in every value the simulation reads. */
const guestAccount: CoopTestAccount = {
  trainerId: 777,
  secretId: 888,
  unlocks: [],
  caughtSpecies: [SpeciesId.PIDGEY, SpeciesId.RATTATA],
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
