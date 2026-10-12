import { applyCoopBossStatMultiplier, COOP_FINAL_BOSS_STAT_MULTIPLIER } from "#coop/coop-battle-rules";
import { beginCoopSession, createCoopGameMode } from "#coop/coop-game-start";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { createLoopbackPair } from "#coop/loopback-transport";
import { BattleType } from "#enums/battle-type";
import { BiomeId } from "#enums/biome-id";
import { ClassicFixedBossWaves } from "#enums/fixed-boss-waves";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import type { Pokemon } from "#field/pokemon";
import * as MysteryEncounters from "#mystery-encounters/mystery-encounter-biomes";
import { GameManager } from "#test/framework/game-manager";
import { createFreshGameManager, createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import { NumberHolder } from "#utils/common";
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
  seed: "coop-battle-rules",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR), createTestStarterPayload(SpeciesId.PIDGEY)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER), createTestStarterPayload(SpeciesId.RATTATA)],
  },
  timedEvent: null,
});

describe("co-op battle rules", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.battleStyle(null).enemyMoveset(MoveId.SPLASH).startingLevel(100);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  /** A wave that is always the single-enemy Fight or Flight encounter. */
  function useFightOrFlight(): void {
    game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(BiomeId.CAVE).disableTrainerWaves();
    vi.spyOn(MysteryEncounters, "mysteryEncountersByBiome", "get").mockReturnValue(
      new Map<BiomeId, MysteryEncounterType[]>([[BiomeId.CAVE, [MysteryEncounterType.FIGHT_OR_FLIGHT]]]),
    );
  }

  function ownersOnField(): (CoopRole | undefined)[] {
    return game.scene.getPlayerField().map(p => coopSession?.ownership.get(p.id));
  }

  describe("forced double battles", () => {
    it("makes wild waves 2v2 with the host on the left", async () => {
      game.override.disableTrainerWaves();
      for (const role of ["host", "guest"] as const) {
        if (role === "guest") {
          game = createFreshGameManager(phaserGame);
          game.override.battleStyle(null).enemyMoveset(MoveId.SPLASH).startingLevel(100).disableTrainerWaves();
        }
        await startCoopBattle(game, { role, start: startInfo() });

        expect(game.scene.currentBattle.battleType).toBe(BattleType.WILD);
        expect(game.scene.currentBattle.double).toBe(true);
        expect(game.scene.getEnemyField()).toHaveLength(2);
        expect(ownersOnField()).toEqual(["host", "guest"]);
        expect(game.scene.getPlayerField().map(p => p.species.speciesId)).toEqual([
          SpeciesId.BULBASAUR,
          SpeciesId.CHARMANDER,
        ]);
        setCoopSession(null);
      }
    });

    it("makes fixed trainer battles double", async () => {
      game.override.startingWave(ClassicFixedBossWaves.RIVAL_1);
      await startCoopBattle(game, { role: "host", start: startInfo() });

      const battle = game.scene.currentBattle;
      expect(battle.battleType).toBe(BattleType.TRAINER);
      expect(battle.double).toBe(true);
      expect(game.scene.getEnemyField()).toHaveLength(Math.min(2, game.scene.getEnemyParty().length));
      expect(game.scene.getEnemyField().filter(p => p.isOnField())).toHaveLength(
        Math.min(2, game.scene.getEnemyParty().length),
      );
    });

    it("keeps the classic final boss alone", async () => {
      game.override.startingWave(200).startingBiome(BiomeId.END);
      await startCoopBattle(game, { role: "host", start: startInfo() });

      const battle = game.scene.currentBattle;
      expect(battle.isClassicFinalBoss).toBe(true);
      expect(battle.double).toBe(true);
      expect(game.scene.getEnemyParty()).toHaveLength(1);
      expect(game.scene.getEnemyField()[0].species.speciesId).toBe(SpeciesId.ETERNATUS);
      expect(ownersOnField()).toEqual(["host", "guest"]);
    });

    it("fights single-enemy mystery encounters 2v1", async () => {
      useFightOrFlight();
      await game.runToMysteryEncounter(MysteryEncounterType.FIGHT_OR_FLIGHT, [
        SpeciesId.BULBASAUR,
        SpeciesId.CHARMANDER,
      ]);
      game.scene.gameMode = createCoopGameMode();
      const session = beginCoopSession("host", createLoopbackPair().host, startInfo());
      const [first, second] = game.scene.getPlayerParty();
      session.ownership.set(first.id, "host");
      session.ownership.set(second.id, "guest");

      await runMysteryEncounterToEnd(game, 1, undefined, true);

      expect(game.scene.currentBattle.double).toBe(true);
      expect(game.scene.getEnemyParty()).toHaveLength(1);
      expect(game.scene.getPlayerField().filter(p => p.isOnField())).toHaveLength(2);
    });
  });

  describe("final boss phase one", () => {
    /** The enemy's stats as the solo game computes them, leaving the co-op stats in place. */
    function soloStats(pokemon: Pokemon): number[] {
      const session = coopSession;
      const hp = pokemon.hp;
      setCoopSession(null);
      try {
        pokemon.calculateStats();
        return [...pokemon.stats];
      } finally {
        setCoopSession(session);
        pokemon.calculateStats();
        pokemon.hp = hp;
      }
    }

    beforeEach(() => {
      game.override.startingWave(200).startingBiome(BiomeId.END);
    });

    it("boosts every stat by half in co-op", async () => {
      await startCoopBattle(game, { role: "host", start: startInfo() });
      const eternatus = game.scene.getEnemyField()[0];
      expect(eternatus.formIndex).toBe(0);

      const solo = soloStats(eternatus);
      expect(eternatus.stats).toEqual(solo.map(value => Math.floor(value * COOP_FINAL_BOSS_STAT_MULTIPLIER)));
      expect(eternatus.hp).toBe(eternatus.getMaxHp());
    });

    it("drops the boost in phase two", async () => {
      await startCoopBattle(game, { role: "host", start: startInfo() });
      const eternatus = game.scene.getEnemyField()[0];

      eternatus.formIndex = 1;
      eternatus.calculateStats();

      expect(eternatus.stats).toEqual(soloStats(eternatus));
    });

    it("leaves other enemies alone", async () => {
      game.override.startingWave(199);
      await startCoopBattle(game, { role: "host", start: startInfo() });
      const enemy = game.scene.getEnemyField()[0];

      expect(enemy.stats).toEqual(soloStats(enemy));
    });

    it("does nothing in solo", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);
      const eternatus = game.scene.getEnemyField()[0];
      expect(eternatus.species.speciesId).toBe(SpeciesId.ETERNATUS);

      const stat = new NumberHolder(100);
      applyCoopBossStatMultiplier(eternatus, stat);
      expect(stat.value).toBe(100);
    });
  });

  describe("solo", () => {
    it("keeps the final boss a single battle", async () => {
      game.override.startingWave(200).startingBiome(BiomeId.END);
      await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);

      expect(game.scene.currentBattle.double).toBe(false);
      expect(game.scene.getEnemyParty()).toHaveLength(1);
    });

    it("keeps single-enemy mystery encounters single", async () => {
      useFightOrFlight();
      await game.runToMysteryEncounter(MysteryEncounterType.FIGHT_OR_FLIGHT, [
        SpeciesId.BULBASAUR,
        SpeciesId.CHARMANDER,
      ]);
      await runMysteryEncounterToEnd(game, 1, undefined, true);

      expect(game.scene.currentBattle.double).toBe(false);
    });
  });
});
