import { getCoopBannerText } from "#coop/coop-banner";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterTier } from "#enums/mystery-encounter-tier";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { allMysteryEncounters, mysteryEncountersByBiome } from "#mystery-encounters/mystery-encounter-biomes";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle, startCoopEncounter } from "#test/utils/coop-replay";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import type { MessageUiHandler } from "#ui/message-ui-handler";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import type { PartyUiHandler } from "#ui/party-ui-handler";
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

  describe("pokemon picks", () => {
    /** Wave 13 is the host's to choose; Part-Timer's first option works a chosen pokemon down to 2 PP a move. */
    const WAVE = 13;

    async function startPartTimer(role: CoopRole): Promise<CoopTestPartner> {
      game.override.startingWave(WAVE).moveset([MoveId.TACKLE]);
      const partner = new CoopTestPartner(role);
      await startCoopEncounter(game, {
        role,
        start: startInfo(),
        transport: partner.localTransport,
        encounter: MysteryEncounterType.PART_TIMER,
      });
      return partner;
    }

    const encounterUi = () => game.scene.ui.getHandler() as MysteryEncounterUiHandler;
    const party = () => game.scene.getPlayerParty();
    /** Whether the pokemon was put to work (its PP went down). */
    const worked = (slot: number) => party()[slot].moveset[0].ppUsed > 0;
    const choices = (partner: CoopTestPartner) =>
      partner.received.filter((m): m is Extract<CoopMessage, { t: "choice" }> => m.t === "choice");

    /** As the picker: take the first option and pick a party slot. */
    async function pickSlot(slot: number): Promise<void> {
      encounterUi().processInput(Button.ACTION);
      await selectInParty(slot);
    }

    /** Pick a slot in the open party screen. */
    async function selectInParty(slot: number): Promise<void> {
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.PARTY);
      const partyUi = game.scene.ui.getHandler() as PartyUiHandler;
      partyUi.setCursor(slot);
      partyUi.processInput(Button.ACTION);
      partyUi.processInput(Button.ACTION);
    }

    it("needs no confirmation for the picker's own pokemon", async () => {
      const partner = await startPartTimer("host");
      await pickSlot(0);
      await vi.waitUntil(() => worked(0));

      expect(choices(partner).map(m => [m.kind, m.payload])).toEqual([
        ["meOption", { index: 0 }],
        ["partySelect", { kind: "partySelect", seq: 0, slot: 0 }],
      ]);
      expect(worked(1)).toBe(false);
    });

    it("asks the owner before using the partner's pokemon", async () => {
      const partner = await startPartTimer("host");
      await pickSlot(1);
      await vi.waitUntil(() => choices(partner).some(m => m.kind === "ownerAsk"));

      expect(choices(partner).at(-1)).toEqual({
        t: "choice",
        kind: "ownerAsk",
        wave: WAVE,
        payload: { seq: 0, slot: 1 },
      });
      expect(worked(1)).toBe(false);
      partner.send({ t: "confirm", kind: "mePokemon", wave: WAVE, seq: 0, accepted: true });
      await vi.waitUntil(() => worked(1));

      expect(choices(partner).at(-1)?.payload).toEqual({ kind: "partySelect", seq: 0, slot: 1 });
    });

    it("lets the picker choose again when the owner declines", async () => {
      const partner = await startPartTimer("host");
      await pickSlot(1);
      await vi.waitUntil(() => choices(partner).some(m => m.kind === "ownerAsk"));
      partner.send({ t: "confirm", kind: "mePokemon", wave: WAVE, seq: 0, accepted: false });
      await vi.waitUntil(() => game.textInterceptor.logs.includes(coopText("ownerDeclined")));
      (game.scene.ui.getHandler() as MessageUiHandler).processInput(Button.ACTION);
      await selectInParty(0);
      await vi.waitUntil(() => worked(0));

      expect(game.textInterceptor.logs).toContain(coopText("ownerDeclined"));
      expect(worked(1)).toBe(false);
      expect(choices(partner).at(-1)?.payload).toEqual({ kind: "partySelect", seq: 0, slot: 0 });
    });

    /** As the owner of the asked pokemon: the host picks option 1 and asks for the guest's pokemon. */
    async function askedAsGuest(partner: CoopTestPartner, accept: boolean): Promise<void> {
      partner.send({ t: "choice", kind: "meOption", wave: WAVE, payload: { index: 0 } });
      partner.send({ t: "choice", kind: "ownerAsk", wave: WAVE, payload: { seq: 0, slot: 1 } });
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.CONFIRM);
      expect(game.textInterceptor.logs.at(-1)).toBe(
        coopText("ownerAsk", { pokemonName: party()[1].getNameToRender() }),
      );
      const confirm = game.scene.ui.getHandler() as ConfirmUiHandler;
      confirm.setCursor(accept ? 0 : 1);
      confirm.processInput(Button.ACTION);
      await vi.waitUntil(() => partner.received.some(m => m.t === "confirm"));
    }

    it("lets the owner allow the pick and follows it", async () => {
      const partner = await startPartTimer("guest");
      await askedAsGuest(partner, true);

      expect(partner.received.find(m => m.t === "confirm")).toEqual({
        t: "confirm",
        kind: "mePokemon",
        wave: WAVE,
        seq: 0,
        accepted: true,
      });
      partner.sendDecision({ kind: "partySelect", seq: 0, slot: 1 });
      await vi.waitUntil(() => worked(1));
      expect(worked(0)).toBe(false);
    });

    it("lets the owner decline the pick", async () => {
      const partner = await startPartTimer("guest");
      await askedAsGuest(partner, false);

      expect(partner.received.find(m => m.t === "confirm")).toMatchObject({ kind: "mePokemon", accepted: false });
      expect(worked(1)).toBe(false);
    });
  });

  describe("follow-up options", () => {
    /** Field Trip's first option picks a pokemon, then one of its moves. */
    const WAVE = 13;

    async function startFieldTrip(role: CoopRole): Promise<CoopTestPartner> {
      game.override.startingWave(WAVE).moveset([MoveId.TACKLE, MoveId.GROWL]);
      const partner = new CoopTestPartner(role);
      await startCoopEncounter(game, {
        role,
        start: startInfo(),
        transport: partner.localTransport,
        encounter: MysteryEncounterType.FIELD_TRIP,
      });
      return partner;
    }

    it("sends the picker's follow-up option", async () => {
      const partner = await startFieldTrip("host");
      (game.scene.ui.getHandler() as MysteryEncounterUiHandler).processInput(Button.ACTION);
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.PARTY);
      const partyUi = game.scene.ui.getHandler() as PartyUiHandler;
      partyUi.setCursor(0);
      partyUi.processInput(Button.ACTION);
      partyUi.processInput(Button.ACTION);
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.OPTION_SELECT);
      const options = game.scene.ui.getHandler() as OptionSelectUiHandler;
      options["unblockInput"]();
      options.setCursor(1);
      options.processInput(Button.ACTION);
      await vi.waitUntil(() => partner.received.filter(m => m.t === "choice").length === 3);

      expect(partner.received.filter(m => m.t === "choice").map(m => m.payload)).toEqual([
        { index: 0 },
        { kind: "partySelect", seq: 0, slot: 0 },
        { kind: "option", seq: 1, index: 1 },
      ]);
    });

    it("follows the picker's pokemon and follow-up option", async () => {
      const partner = await startFieldTrip("guest");
      partner.send({ t: "choice", kind: "meOption", wave: WAVE, payload: { index: 0 } });
      partner.sendDecision({ kind: "partySelect", seq: 0, slot: 0 });
      partner.sendDecision({ kind: "option", seq: 1, index: 1 });
      await game.phaseInterceptor.to("MysteryEncounterOptionSelectedPhase", false);

      const encounter = game.scene.currentBattle.mysteryEncounter!;
      expect(encounter.selectedOption).toBe(encounter.options[0]);
      // The follow-up option was applied: the chosen move was judged.
      expect(encounter.misc).toHaveProperty("correctMove");
    });
  });
});
