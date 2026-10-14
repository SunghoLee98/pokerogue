import { findFirstDesync } from "#coop/coop-desync";
import type { CoopMessage } from "#coop/coop-protocol";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { getPlayerShopModifierTypeOptionsForWave } from "#modifiers/modifier-type";
import { GameManager } from "#test/framework/game-manager";
import {
  type CoopReplayLog,
  type CoopReplayOptions,
  type CoopTestAccount,
  createFreshGameManager,
  inputsBy,
  runCoopReplay,
} from "#test/utils/coop-replay";
import { PartyOption } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const hostAccount: CoopTestAccount = {
  trainerId: 12345,
  secretId: 54321,
  unlocks: [],
  caughtSpecies: [],
  eggMoves: {},
};
const guestAccount: CoopTestAccount = { trainerId: 777, secretId: 888, unlocks: [], caughtSpecies: [], eggMoves: {} };

type RewardMessage = Extract<CoopMessage, { t: "reward" }>;

const POTION = 0;

describe("co-op progression replay", () => {
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

  /** Both players use Hyper Voice, which wins every wave on the first turn. */
  const hyperVoice = () => ({ kind: "move" as const, moveId: MoveId.HYPER_VOICE });

  function prepare(setup?: (game: GameManager) => void): void {
    game.override.moveset([MoveId.HYPER_VOICE, MoveId.SPLASH]).enemyLevel(5);
    setup?.(game);
  }

  /** Record as the host, then replay as the guest. */
  async function recordAndReplay(
    options: Partial<CoopReplayOptions>,
    setup?: (game: GameManager) => void,
  ): Promise<{ hostLog: CoopReplayLog; guestLog: CoopReplayLog }> {
    const common = {
      accounts: { host: hostAccount, guest: guestAccount },
      species: [SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER] as [SpeciesId, SpeciesId],
      waves: 3,
      ...options,
    };
    prepare(setup);
    const hostLog = await runCoopReplay(game, {
      ...common,
      role: "host",
      localCommand: hyperVoice,
      remote: { command: hyperVoice },
    });
    game = createFreshGameManager(phaserGame);
    prepare(setup);
    const guestLog = await runCoopReplay(game, {
      ...common,
      role: "guest",
      localCommand: hyperVoice,
      remote: { log: hostLog },
    });
    return { hostLog, guestLog };
  }

  function expectInSync({ hostLog, guestLog }: { hostLog: CoopReplayLog; guestLog: CoopReplayLog }): void {
    expect(findFirstDesync(hostLog.checksums, guestLog.checksums)).toBeNull();
    expect(inputsBy(guestLog, "guest")).toEqual(inputsBy(hostLog, "guest"));
    expect(inputsBy(guestLog, "host")).toEqual(inputsBy(hostLog, "host"));
  }

  /** The numbered reward events the host sent, in order. */
  const orderedEvents = (log: CoopReplayLog) =>
    inputsBy(log, "host")
      .map(i => i.message)
      .filter((m): m is RewardMessage => m.t === "reward");

  /** The state hashed when a wave's reward screen opened, and at the start of the next wave. */
  const aroundRewards = (log: CoopReplayLog, wave: number) => {
    const index = log.states.findIndex(s => s.wave === wave && s.rewardOptions.length > 0);
    return { screen: log.states[index], next: log.states[index + 1] };
  };

  it("takes turns picking the reward over two waves", async () => {
    const logs = await recordAndReplay(
      {
        rewards: wave =>
          wave === 1
            ? { host: [{ kind: "reward", option: 1, slot: 1, partyOption: PartyOption.APPLY }] }
            : { guest: [{ kind: "reroll" }, { kind: "reward", option: 0 }] },
      },
      g => g.override.itemRewards([{ name: "EXP_SHARE" }, { name: "LEFTOVERS" }, { name: "EXP_SHARE" }]),
    );

    expectInSync(logs);
    expect(orderedEvents(logs.hostLog).map(m => [m.wave, m.by, m.seq, m.action.kind])).toEqual([
      [1, "host", 0, "reward"],
      [2, "guest", 1, "reroll"],
      [2, "guest", 2, "reward"],
    ]);
    const finalState = logs.hostLog.states.at(-1)!;
    const charmanderId = finalState.playerParty[1].id;
    expect(finalState.modifiers).toContainEqual(["LEFTOVERS", 1, charmanderId]);
    expect(finalState.modifiers).toContainEqual(["EXP_SHARE", 1, -1]);
    // The reroll was paid once.
    const { screen, next } = aroundRewards(logs.hostLog, 2);
    expect(screen.money - next.money).toBe(250);
  });

  it("orders both players' shop buys the same way on both clients", async () => {
    let potionCost = 0;
    const logs = await recordAndReplay({
      onStart: g => {
        for (const pokemon of g.scene.getPlayerParty()) {
          pokemon.hp = 1;
        }
      },
      rewards: wave => {
        if (wave !== 2) {
          return {};
        }
        potionCost = getPlayerShopModifierTypeOptionsForWave(2, game.scene.getWaveMoneyAmount(1))[POTION].cost;
        const potionFor = (slot: number) => ({
          kind: "shop" as const,
          option: POTION,
          slot,
          partyOption: PartyOption.APPLY,
        });
        return { host: [potionFor(0)], guest: [potionFor(1), { kind: "skip" }] };
      },
    });

    expectInSync(logs);
    expect(
      orderedEvents(logs.hostLog)
        .filter(m => m.wave === 2)
        .map(m => [m.by, m.seq, m.action.kind]),
    ).toEqual([
      ["host", 1, "shop"],
      ["guest", 2, "shop"],
      ["guest", 3, "skip"],
    ]);
    const { screen, next } = aroundRewards(logs.hostLog, 2);
    expect(screen.money - next.money).toBe(2 * potionCost);
    expect(next.playerParty.slice(0, 2).every(p => p.hp > 1)).toBe(true);
  });

  it("rejects the buy the shared wallet no longer covers on both clients", async () => {
    const logs = await recordAndReplay({
      onStart: g => {
        for (const pokemon of g.scene.getPlayerParty()) {
          pokemon.hp = 1;
        }
      },
      rewards: wave => {
        if (wave !== 2) {
          return {};
        }
        game.scene.money = getPlayerShopModifierTypeOptionsForWave(2, game.scene.getWaveMoneyAmount(1))[POTION].cost;
        const potionFor = (slot: number) => ({
          kind: "shop" as const,
          option: POTION,
          slot,
          partyOption: PartyOption.APPLY,
        });
        return { host: [potionFor(0)], guest: [potionFor(1), { kind: "skip" }] };
      },
    });

    expectInSync(logs);
    const { next } = aroundRewards(logs.hostLog, 2);
    expect(next.money).toBe(0);
    expect(next.playerParty[0].hp).toBeGreaterThan(1);
    expect(next.playerParty[1].hp).toBe(1);
  });
});
