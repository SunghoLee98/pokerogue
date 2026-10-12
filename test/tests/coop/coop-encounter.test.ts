import { getCoopBannerText } from "#coop/coop-banner";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterTier } from "#enums/mystery-encounter-tier";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { allMysteryEncounters, mysteryEncountersByBiome } from "#mystery-encounters/mystery-encounter-biomes";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle, startCoopEncounter } from "#test/utils/coop-replay";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
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

  describe("option turns", () => {
    /** Wave 13 is the host's to choose. */
    const WAVE = 13;

    async function startEncounter(role: CoopRole): Promise<CoopTestPartner> {
      game.override.startingWave(WAVE);
      const partner = new CoopTestPartner(role);
      await startCoopEncounter(game, {
        role,
        start: startInfo(),
        transport: partner.localTransport,
        encounter: MysteryEncounterType.DEPARTMENT_STORE_SALE,
      });
      return partner;
    }

    const encounterUi = () => game.scene.ui.getHandler() as MysteryEncounterUiHandler;
    const encounter = () => game.scene.currentBattle.mysteryEncounter!;
    /** Press the action button on the second option. */
    const chooseSecond = () => {
      encounterUi().processInput(Button.RIGHT);
      encounterUi().processInput(Button.ACTION);
    };

    it("sends the picker's option", async () => {
      const partner = await startEncounter("host");
      chooseSecond();
      await vi.waitUntil(() => partner.received.some(m => m.t === "choice"));

      expect(partner.received.filter(m => m.t === "choice")).toEqual([
        { t: "choice", kind: "meOption", wave: WAVE, payload: { index: 1 } },
      ]);
      expect(encounter().selectedOption).toBe(encounter().options[1]);
    });

    it("pings for the other player and follows the picker's option", async () => {
      const partner = await startEncounter("guest");
      expect(getCoopBannerText()).toBe(coopText("waitingForPartnerChoice"));
      chooseSecond();
      await vi.waitUntil(() => partner.received.some(m => m.t === "ping"));

      expect(partner.received.find(m => m.t === "ping")).toEqual({
        t: "ping",
        kind: "encounter",
        payload: { index: 1 },
      });
      expect(encounter().selectedOption).toBeUndefined();
      partner.send({ t: "choice", kind: "meOption", wave: WAVE, payload: { index: 1 } });
      await game.phaseInterceptor.to("MysteryEncounterOptionSelectedPhase", false);

      expect(encounter().selectedOption).toBe(encounter().options[1]);
      expect(getCoopBannerText()).toBeNull();
    });
  });
});
