import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterTier } from "#enums/mystery-encounter-tier";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { allMysteryEncounters, mysteryEncountersByBiome } from "#mystery-encounters/mystery-encounter-biomes";
import { GameManager } from "#test/framework/game-manager";
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
  seed: "coop-encounter",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

/** The encounters co-op leaves out (spec 3.10). */
const EXCLUDED = [
  MysteryEncounterType.SAFARI_ZONE,
  MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER,
  MysteryEncounterType.FUN_AND_GAMES,
];

describe("co-op mystery encounters", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.battleStyle(null).disableTrainerWaves().startingWave(3).enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  describe("exclusion", () => {
    /** Make the biome offer only the excluded encounters, all available, and draw one of `tier`. */
    function drawFromExcluded(tier: MysteryEncounterTier): MysteryEncounterType {
      const biome = game.scene.arena.biomeId;
      const original = mysteryEncountersByBiome.get(biome);
      mysteryEncountersByBiome.set(biome, EXCLUDED);
      for (const type of EXCLUDED) {
        vi.spyOn(allMysteryEncounters[type], "meetsRequirements").mockReturnValue(true);
      }
      game.override.mysteryEncounterTier(tier);
      try {
        return game.scene.getMysteryEncounter().encounterType;
      } finally {
        mysteryEncountersByBiome.set(biome, original ?? []);
      }
    }

    it("never draws the excluded encounters in co-op", async () => {
      await startCoopBattle(game, { role: "host", start: startInfo() });

      expect(drawFromExcluded(MysteryEncounterTier.GREAT)).toBe(MysteryEncounterType.MYSTERIOUS_CHALLENGERS);
      expect(drawFromExcluded(MysteryEncounterTier.ULTRA)).toBe(MysteryEncounterType.MYSTERIOUS_CHALLENGERS);
    });

    it("still draws them in solo", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR);

      expect([MysteryEncounterType.SAFARI_ZONE, MysteryEncounterType.FUN_AND_GAMES]).toContain(
        drawFromExcluded(MysteryEncounterTier.GREAT),
      );
      expect(drawFromExcluded(MysteryEncounterTier.ULTRA)).toBe(MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER);
    });
  });
});
