import { getRandomTrainerFunc } from "#app/battle";
import type { BattleScene } from "#app/battle-scene";
import { CoopSession, setCoopSession } from "#coop/coop-session";
import { createLoopbackPair } from "#coop/loopback-transport";
import { generateRandomStatusEffect, getRandomStatus, getRandomStatusEffect, Status } from "#data/status-effect";
import { BiomeId } from "#enums/biome-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { TrainerType } from "#enums/trainer-type";
import * as MysteryEncounters from "#mystery-encounters/mystery-encounter-biomes";
import { CIVILIZATION_ENCOUNTER_BIOMES } from "#mystery-encounters/mystery-encounter-biomes";
import { GameManager } from "#test/framework/game-manager";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import * as Utils from "#utils/common";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

function startCoop(): void {
  const session = new CoopSession("guest", createLoopbackPair().guest);
  // The simulation reads account data from the shared snapshots in co-op.
  const snapshot = { trainerId: 0, secretId: 0, caughtSpecies: [], eggMoves: {}, unlocks: [] };
  session.setAccountSnapshot("host", snapshot);
  session.setAccountSnapshot("guest", snapshot);
  setCoopSession(session);
}

describe("co-op seeded randomness at call sites", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    setCoopSession(null);
    vi.restoreAllMocks();
  });

  describe("status effects", () => {
    const burn = new Status(StatusEffect.BURN);
    const poison = new Status(StatusEffect.POISON);

    it("stay unseeded in solo", () => {
      const unseeded = vi.spyOn(Utils, "randIntRange");
      const seeded = vi.spyOn(Utils, "randSeedIntRange");

      getRandomStatus(burn, poison);
      getRandomStatusEffect(StatusEffect.BURN, StatusEffect.POISON);
      generateRandomStatusEffect();

      expect(unseeded).toHaveBeenCalledTimes(3);
      expect(seeded).not.toHaveBeenCalled();
    });

    it("use the seeded RNG in co-op", () => {
      startCoop();
      const unseeded = vi.spyOn(Utils, "randIntRange");
      const seeded = vi.spyOn(Utils, "randSeedIntRange");

      getRandomStatus(burn, poison);
      getRandomStatusEffect(StatusEffect.BURN, StatusEffect.POISON);
      generateRandomStatusEffect();

      expect(seeded).toHaveBeenCalledTimes(3);
      expect(unseeded).not.toHaveBeenCalled();
    });
  });

  describe("evil team grunt variants", () => {
    beforeEach(() => {
      new GameManager(phaserGame);
    });

    it("stay unseeded in solo", () => {
      const unseeded = vi.spyOn(Utils, "randInt");

      getRandomTrainerFunc([TrainerType.ROCKET_GRUNT], true)();

      // `randInt(n)` and `randInt(n, 0)` are the same call.
      expect(unseeded).toHaveBeenCalledWith(2, 0);
      expect(unseeded).toHaveBeenCalledWith(3, 0);
    });

    it("use the seeded RNG in co-op", () => {
      startCoop();
      const unseeded = vi.spyOn(Utils, "randInt");
      const seeded = vi.spyOn(Utils, "randSeedInt");

      getRandomTrainerFunc([TrainerType.ROCKET_GRUNT], true)();

      expect(unseeded).not.toHaveBeenCalled();
      expect(seeded).toHaveBeenCalledWith(2, 0);
      expect(seeded).toHaveBeenCalledWith(3, 0);
    });
  });

  describe("Global Trade System wonder trade ball", () => {
    let game: GameManager;
    let scene: BattleScene;

    beforeEach(() => {
      game = new GameManager(phaserGame);
      scene = game.scene;
      game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(BiomeId.CAVE).disableTrainerWaves();
      const biomeMap = new Map<BiomeId, MysteryEncounterType[]>();
      for (const biome of CIVILIZATION_ENCOUNTER_BIOMES) {
        biomeMap.set(biome, [MysteryEncounterType.GLOBAL_TRADE_SYSTEM]);
      }
      vi.spyOn(MysteryEncounters, "mysteryEncountersByBiome", "get").mockReturnValue(biomeMap);
    });

    /** @param coop - Whether to trade in co-op; the session starts after the title screen, which leaves co-op */
    const tradeWithFixedRolls = async (coop: boolean) => {
      await game.runToMysteryEncounter(MysteryEncounterType.GLOBAL_TRADE_SYSTEM, [
        SpeciesId.LAPRAS,
        SpeciesId.GENGAR,
        SpeciesId.ABRA,
      ]);
      if (coop) {
        startCoop();
      }
      // Unseeded rolls pick the highest value, seeded rolls pick 1.
      vi.spyOn(Utils, "randInt").mockImplementation((range: number, min = 0) => min + range - 1);
      vi.spyOn(Utils, "randSeedInt").mockReturnValue(1);
      await runMysteryEncounterToEnd(game, 2, { pokemonNo: 1 });
      return scene.getPlayerParty().at(-1)!.pokeball;
    };

    it("stays unseeded in solo", async () => {
      expect(await tradeWithFixedRolls(false)).toBe(3);
    });

    it("uses the seeded RNG in co-op", async () => {
      expect(await tradeWithFixedRolls(true)).toBe(1);
    });
  });
});
