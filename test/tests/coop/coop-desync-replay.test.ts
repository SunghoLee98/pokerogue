import { settings } from "#app/global-settings-manager";
import { findFirstDesync } from "#coop/coop-desync";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import { GameManager } from "#test/framework/game-manager";
import {
  type CoopReplayCommandFn,
  type CoopReplayLog,
  type CoopTestAccount,
  createFreshGameManager,
  inputsBy,
  runCoopReplay,
} from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SPECIES: [SpeciesId, SpeciesId] = [SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER];
const WAVES = 2;

const hostAccount: CoopTestAccount = {
  trainerId: 12345,
  secretId: 54321,
  unlocks: [],
  caughtSpecies: [],
  eggMoves: {},
};

/** Attack the first living enemy, preferring the given slot. */
function attack(game: GameManager, moveId: MoveId, preferred: BattlerIndex.ENEMY | BattlerIndex.ENEMY_2) {
  return (() => {
    const [first, second] = game.scene.getEnemyField();
    const slots = preferred === BattlerIndex.ENEMY ? [first, second] : [second, first];
    const target = slots.find(p => p && !p.isFainted()) ?? slots[0];
    return { kind: "move" as const, moveId, target: target.getBattlerIndex() };
  }) satisfies CoopReplayCommandFn;
}

/** Account data for the guest that differs from the host in every value the simulation reads. */
function guestAccountFor(hostLog: CoopReplayLog): CoopTestAccount {
  const enemyId = hostLog.enemyIds[0][0];
  const f = ((enemyId & 0xffff0000) >>> 16) ^ (enemyId & 0x0000ffff);
  return {
    // With these ids the first enemy would roll shiny.
    trainerId: f,
    secretId: 0,
    unlocks: [Unlockables.EVIOLITE, Unlockables.MINI_BLACK_HOLE],
    caughtSpecies: [SpeciesId.SHELMET, SpeciesId.RESHIRAM, SpeciesId.ZEKROM],
    eggMoves: { [SpeciesId.SQUIRTLE]: 0b1111, [SpeciesId.CHARMANDER]: 0b1111 },
  };
}

describe("co-op desync replay", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let moveAnimations: boolean;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH]);
    moveAnimations = settings.display.enableMoveAnimations;
  });

  afterEach(() => {
    settings.display.enableMoveAnimations = moveAnimations;
  });

  /** Record a run as the host, with the guest's commands given live. */
  function recordHost(guestAccount: CoopTestAccount = hostAccount): Promise<CoopReplayLog> {
    return runCoopReplay(game, {
      role: "host",
      accounts: { host: hostAccount, guest: guestAccount },
      localCommand: attack(game, MoveId.TACKLE, BattlerIndex.ENEMY),
      remote: { command: attack(game, MoveId.SCRATCH, BattlerIndex.ENEMY_2) },
      species: SPECIES,
      waves: WAVES,
    });
  }

  /** Replay as the guest in a fresh game, taking the host's commands from the log. */
  function replayGuest(hostLog: CoopReplayLog, guestAccount: CoopTestAccount, wrongWorldData = false) {
    game = createFreshGameManager(phaserGame);
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH]);
    return runCoopReplay(game, {
      role: "guest",
      accounts: { host: hostAccount, guest: guestAccount },
      localCommand: attack(game, MoveId.SCRATCH, BattlerIndex.ENEMY_2),
      remote: { log: hostLog },
      species: SPECIES,
      waves: WAVES,
      // As if a world-level read leaked through to the guest's own account data
      ...(wrongWorldData && {
        worldDataOverride: {
          trainerId: guestAccount.trainerId,
          secretId: guestAccount.secretId,
          caughtSpecies: [],
          eggMoves: {},
          unlocks: guestAccount.unlocks,
        },
      }),
    });
  }

  it("host run is reproducible", async () => {
    const first = await recordHost();
    game = createFreshGameManager(phaserGame);
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH]);
    const second = await recordHost();

    expect(second.checksums).toEqual(first.checksums);
    expect(first.checksums.length).toBeGreaterThanOrEqual(3);
    expect(new Set(first.checksums.map(c => c.wave)).size).toBe(WAVES);
    expect(first.inputs.filter(i => i.by === "guest").length).toBeGreaterThan(0);
  });

  it("guest replay with different account data matches the host hashes", async () => {
    const probe = await recordHost();
    const guestAccount = guestAccountFor(probe);

    game = createFreshGameManager(phaserGame);
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH]);
    const hostLog = await recordHost(guestAccount);
    // Sanity: the host's own ids keep the first enemy non-shiny, the guest's would make it shiny.
    const enemyId = hostLog.enemyIds[0][0];
    const f = ((enemyId & 0xffff0000) >>> 16) ^ (enemyId & 0x0000ffff);
    expect((hostAccount.trainerId ^ hostAccount.secretId ^ f) >= 64).toBe(true);
    expect(guestAccount.trainerId ^ guestAccount.secretId ^ f).toBe(0);

    const guestLog = await replayGuest(hostLog, guestAccount);

    expect(findFirstDesync(hostLog.checksums, guestLog.checksums)).toBeNull();
    expect(inputsBy(guestLog, "guest")).toEqual(inputsBy(hostLog, "guest"));
    expect(inputsBy(guestLog, "host")).toEqual(inputsBy(hostLog, "host"));
  });

  it("detects a divergence injected through wrong world data", async () => {
    const probe = await recordHost();
    const guestAccount = guestAccountFor(probe);
    game = createFreshGameManager(phaserGame);
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH]);
    const hostLog = await recordHost(guestAccount);

    const guestLog = await replayGuest(hostLog, guestAccount, true);

    const desync = findFirstDesync(hostLog.checksums, guestLog.checksums);
    expect(desync).not.toBeNull();
    expect(desync?.index).toBe(0);
    expect(desync?.expected?.wave).toBe(hostLog.checksums[0].wave);
  });

  it("move animation setting does not change the hashes", async () => {
    const probe = await recordHost();
    const guestAccount = guestAccountFor(probe);
    game = createFreshGameManager(phaserGame);
    game.override.moveset([MoveId.TACKLE, MoveId.SCRATCH]);
    settings.display.enableMoveAnimations = true;
    const hostLog = await recordHost(guestAccount);

    settings.display.enableMoveAnimations = false;
    const guestLog = await replayGuest(hostLog, guestAccount);

    expect(findFirstDesync(hostLog.checksums, guestLog.checksums)).toBeNull();
  });
});
