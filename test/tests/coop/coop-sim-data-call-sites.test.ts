import { speciesDataRegistry } from "#app/global-species-data-registry";
import { speciesEggMoves } from "#balance/moves/egg-moves";
import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { CoopSession, setCoopSession } from "#coop/coop-session";
import { createLoopbackPair } from "#coop/loopback-transport";
import { getCriticalCaptureChance } from "#data/pokeball";
import { getSpeciesDependentFormChangeCondition } from "#data/pokemon-forms";
import { ModifierTier } from "#enums/modifier-tier";
import { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import { modifierPool } from "#modifiers/modifier-pools";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const emptySnapshot = (): CoopAccountSnapshot => ({
  trainerId: 0,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

describe("co-op simulation data at call sites", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.battleStyle("single").enemySpecies(SpeciesId.MAGIKARP);
  });

  afterEach(() => {
    setCoopSession(null);
    vi.restoreAllMocks();
  });

  /** Start a co-op session as the host, with the given snapshots. */
  function startCoop(host: CoopAccountSnapshot, guest: CoopAccountSnapshot = emptySnapshot()): CoopSession {
    const session = new CoopSession("host", createLoopbackPair().host);
    session.setAccountSnapshot("host", host);
    session.setAccountSnapshot("guest", guest);
    setCoopSession(session);
    return session;
  }

  it("rolls enemy shininess with the host trainer id", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const enemy = game.field.getEnemyPokemon();
    const f = ((enemy.id & 0xffff0000) >>> 16) ^ (enemy.id & 0x0000ffff);
    // Locally the enemy can never be shiny; with the host's ids it always is.
    game.scene.gameData.trainerId = f ^ 0x8000;
    game.scene.gameData.secretId = 0;

    enemy.shiny = false;
    expect(enemy.trySetShiny()).toBe(false);

    startCoop({ ...emptySnapshot(), trainerId: f, secretId: 0 });
    enemy.shiny = false;
    expect(enemy.trySetShiny()).toBe(true);
  });

  it("uses the owner's egg moves", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    const bulbasaur = game.field.getPlayerPokemon();
    const [firstEggMove, secondEggMove] = speciesEggMoves[SpeciesId.BULBASAUR];
    game.scene.gameData.starterData[SpeciesId.BULBASAUR].eggMoves = 0b0010;

    const eggMoves = () => bulbasaur.getLearnableLevelMoves().map(m => m[1]);
    expect(eggMoves()).toContain(secondEggMove);
    expect(eggMoves()).not.toContain(firstEggMove);

    const session = startCoop(emptySnapshot(), { ...emptySnapshot(), eggMoves: { [SpeciesId.BULBASAUR]: 0b0001 } });
    session.ownership.set(bulbasaur.id, "guest");
    expect(eggMoves()).toContain(firstEggMove);
    expect(eggMoves()).not.toContain(secondEggMove);
  });

  it("checks species-caught evolutions against the owner's dex", async () => {
    await game.classicMode.startBattle(SpeciesId.KARRABLAST);
    const karrablast = game.field.getPlayerPokemon();
    const evolution = speciesDataRegistry.getEvolutions(SpeciesId.KARRABLAST)[0];
    game.scene.gameData.dexData[SpeciesId.SHELMET].caughtAttr = 0n;

    expect(evolution.condition?.conditionsFulfilled(karrablast)).toBe(false);

    const session = startCoop(emptySnapshot(), { ...emptySnapshot(), caughtSpecies: [SpeciesId.SHELMET] });
    session.ownership.set(karrablast.id, "guest");
    expect(evolution.condition?.conditionsFulfilled(karrablast)).toBe(true);
  });

  it("checks species-dependent form changes against the owner's dex", async () => {
    await game.classicMode.startBattle(SpeciesId.KYUREM);
    const kyurem = game.field.getPlayerPokemon();
    const condition = getSpeciesDependentFormChangeCondition(SpeciesId.RESHIRAM);
    game.scene.gameData.dexData[SpeciesId.RESHIRAM].caughtAttr = 0n;

    expect(condition.predicate(kyurem)).toBe(false);

    const session = startCoop(emptySnapshot(), { ...emptySnapshot(), caughtSpecies: [SpeciesId.RESHIRAM] });
    session.ownership.set(kyurem.id, "guest");
    expect(condition.predicate(kyurem)).toBe(true);
  });

  it("uses the host dex count for critical captures", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    vi.spyOn(game.scene.gameData, "getSpeciesCount").mockReturnValue(0);
    const soloChance = getCriticalCaptureChance(100);

    const caughtSpecies = Array.from({ length: 801 }, (_, i) => i + 1);
    startCoop({ ...emptySnapshot(), caughtSpecies });
    expect(getCriticalCaptureChance(100)).toBeGreaterThan(soloChance);
  });

  it("uses host unlocks for the master reward pool", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    game.scene.gameData.unlocks[Unlockables.MINI_BLACK_HOLE] = false;
    const miniBlackHole = modifierPool[ModifierTier.MASTER]!.find(m => m.modifierType.id === "MINI_BLACK_HOLE")!;
    const weight = miniBlackHole.weight as (...args: unknown[]) => number;
    const party = game.scene.getPlayerParty();

    expect(weight(party)).toBe(0);

    startCoop({ ...emptySnapshot(), unlocks: [Unlockables.MINI_BLACK_HOLE] });
    expect(weight(party)).toBe(1);
  });
});
