import { findFirstDesync } from "#coop/coop-desync";
import type { CoopRole } from "#coop/coop-protocol";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import {
  type CoopReplayAction,
  type CoopReplayCommandFn,
  type CoopReplayLog,
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

const guestAccount: CoopTestAccount = {
  trainerId: 777,
  secretId: 888,
  unlocks: [],
  caughtSpecies: [],
  eggMoves: {},
};

/** What one run left in its local account. */
interface AccountResult {
  /** Rattata's catch count and whether its dex entry is caught or seen */
  rattata: { caughtCount: number; caught: boolean; seen: boolean };
  /** Friendship candy progress gained by each starter's species during the run */
  friendshipGained: Record<CoopRole, number>;
}

const STARTERS: Record<CoopRole, SpeciesId> = { host: SpeciesId.SQUIRTLE, guest: SpeciesId.CHARMANDER };

/** On the first turn, `first`; afterwards, attack the first living enemy. */
function firstTurn(game: () => GameManager, first: CoopReplayAction, moveId: MoveId): CoopReplayCommandFn {
  return (wave, turn) => {
    if (wave === 1 && turn === 1) {
      return first;
    }
    const target = game()
      .scene.getEnemyField()
      .find(p => p && !p.isFainted());
    return { kind: "move", moveId, target: target?.getBattlerIndex() ?? BattlerIndex.ENEMY };
  };
}

// Account records go to each pokemon's owner (spec 3.7), and writing them must not change the shared game.
describe("co-op account progress replay", () => {
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

  function prepare(): void {
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH, MoveId.SPLASH]).enemySpecies(SpeciesId.RATTATA);
  }

  /** Record as the host, replay as the guest, and note what each run left in its own account. */
  async function recordAndReplay(
    host: CoopReplayCommandFn,
    guest: CoopReplayCommandFn,
  ): Promise<{ logs: Record<CoopRole, CoopReplayLog>; accounts: Record<CoopRole, AccountResult> }> {
    const friendshipBefore: Partial<Record<CoopRole, number>> = {};
    const onStart = (g: GameManager) => {
      g.scene.pokeballCounts[PokeballType.MASTER_BALL] = 4;
      // An account that never caught Rattata, so the catch also adds a new starter.
      const rattata = g.scene.gameData.dexData[SpeciesId.RATTATA];
      rattata.caughtAttr = 0n;
      rattata.caughtCount = 0;
      for (const role of ["host", "guest"] as const) {
        friendshipBefore[role] = g.scene.gameData.starterData[STARTERS[role]].friendship ?? 0;
      }
    };
    const result = (): AccountResult => {
      const { dexData, starterData } = game.scene.gameData;
      const rattata = dexData[SpeciesId.RATTATA];
      return {
        rattata: { caughtCount: rattata.caughtCount, caught: rattata.caughtAttr !== 0n, seen: rattata.seenAttr !== 0n },
        friendshipGained: {
          host: (starterData[STARTERS.host].friendship ?? 0) - (friendshipBefore.host ?? 0),
          guest: (starterData[STARTERS.guest].friendship ?? 0) - (friendshipBefore.guest ?? 0),
        },
      };
    };
    const common = {
      accounts: { host: hostAccount, guest: guestAccount },
      species: [STARTERS.host, STARTERS.guest] as [SpeciesId, SpeciesId],
      waves: 2,
      onStart,
    };

    prepare();
    const hostLog = await runCoopReplay(game, {
      ...common,
      role: "host",
      localCommand: host,
      remote: { command: guest },
    });
    const hostResult = result();

    game = createFreshGameManager(phaserGame);
    prepare();
    const guestLog = await runCoopReplay(game, {
      ...common,
      role: "guest",
      localCommand: guest,
      remote: { log: hostLog },
    });
    return { logs: { host: hostLog, guest: guestLog }, accounts: { host: hostResult, guest: result() } };
  }

  function expectInSync(logs: Record<CoopRole, CoopReplayLog>): void {
    expect(findFirstDesync(logs.host.checksums, logs.guest.checksums)).toBeNull();
    expect(inputsBy(logs.guest, "guest")).toEqual(inputsBy(logs.host, "guest"));
    expect(inputsBy(logs.guest, "host")).toEqual(inputsBy(logs.host, "host"));
  }

  it("records the guest's catch on the guest's account only", async () => {
    const { logs, accounts } = await recordAndReplay(
      firstTurn(() => game, { kind: "move", moveId: MoveId.TACKLE, target: BattlerIndex.ENEMY_2 }, MoveId.TACKLE),
      firstTurn(
        () => game,
        { kind: "ball", ball: PokeballType.MASTER_BALL, target: BattlerIndex.ENEMY },
        MoveId.SCRATCH,
      ),
    );

    expectInSync(logs);
    const caught = logs.host.states.at(-1)!.playerParty.find(p => p.speciesId === SpeciesId.RATTATA);
    expect(caught?.owner).toBe("guest");
    expect(accounts.guest.rattata).toEqual({ caughtCount: 1, caught: true, seen: true });
    expect(accounts.host.rattata).toEqual({ caughtCount: 0, caught: false, seen: true });
    // Winning raises friendship; the candy progress goes to each starter's owner.
    expect(accounts.host.friendshipGained.host).toBeGreaterThan(0);
    expect(accounts.host.friendshipGained.guest).toBe(0);
    expect(accounts.guest.friendshipGained.guest).toBeGreaterThan(0);
    expect(accounts.guest.friendshipGained.host).toBe(0);
  });

  it("records the host's catch on the host's account only", async () => {
    const { logs, accounts } = await recordAndReplay(
      firstTurn(
        () => game,
        { kind: "ball", ball: PokeballType.MASTER_BALL, target: BattlerIndex.ENEMY },
        MoveId.TACKLE,
      ),
      firstTurn(() => game, { kind: "move", moveId: MoveId.SCRATCH, target: BattlerIndex.ENEMY_2 }, MoveId.SCRATCH),
    );

    expectInSync(logs);
    expect(accounts.host.rattata).toEqual({ caughtCount: 1, caught: true, seen: true });
    expect(accounts.guest.rattata).toEqual({ caughtCount: 0, caught: false, seen: true });
  });
});
