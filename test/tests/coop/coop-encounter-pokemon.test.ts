import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { EnemyPokemon, PlayerPokemon } from "#field/pokemon";
import { catchPokemon } from "#mystery-encounters/encounter-pokemon-utils";
import * as EncounterTransformationSequence from "#mystery-encounters/encounter-transformation-sequence";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, waitForCoop } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle, startCoopEncounter } from "#test/utils/coop-replay";
import { skipBattleRunMysteryEncounterRewardsPhase } from "#test/utils/encounter-test-utils";
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

/** The host has the most pokemon they may own, the guest one. */
const startInfo = (hostSpecies = [SpeciesId.BULBASAUR, SpeciesId.PIDGEY, SpeciesId.SENTRET]): CoopStartInfo => ({
  seed: "coop-encounter-pokemon",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: hostSpecies.map(createTestStarterPayload),
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

describe("co-op pokemon from mystery encounters", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  /** The number of the first decision made after the battle started */
  let firstSeq = 0;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingLevel(100)
      .enemyLevel(5)
      .enemySpecies(SpeciesId.RATTATA)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  const ownerOf = (pokemon: PlayerPokemon) => coopSession?.ownership.get(pokemon.id);
  const partyIds = () => game.scene.getPlayerParty().map(p => p.id);
  const rattata = () => game.scene.gameData.dexData[SpeciesId.RATTATA];

  /**
   * Start a battle on `wave` (odd waves are the host's to choose on, even waves the guest's) and forget Rattata,
   * the enemy to be given away as an encounter's pokemon.
   */
  async function start(role: CoopRole, wave: number, info = startInfo()): Promise<CoopTestPartner> {
    game.override.startingWave(wave);
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: info, transport: partner.localTransport });
    firstSeq = coopSession!.decisionCount;
    const entry = rattata();
    entry.caughtAttr = 0n;
    entry.caughtCount = 0;
    return partner;
  }

  const enemy = () => game.scene.getEnemyField()[0] as EnemyPokemon;

  describe("catchPokemon", () => {
    it("gives the pokemon to the player choosing on the wave, on that player's account", async () => {
      await start("guest", 4, startInfo([SpeciesId.BULBASAUR]));
      const caught = enemy();
      await catchPokemon(caught, null, PokeballType.POKEBALL, false);

      const added = game.scene.getPlayerParty().find(p => p.id === caught.id);
      expect(added).toBeDefined();
      expect(ownerOf(added!)).toBe("guest");
      expect(rattata().caughtCount).toBe(1);
    });

    it("only lets the other player see it", async () => {
      await start("host", 4, startInfo([SpeciesId.BULBASAUR]));
      const caught = enemy();
      await catchPokemon(caught, null, PokeballType.POKEBALL, false);

      const added = game.scene.getPlayerParty().find(p => p.id === caught.id);
      expect(ownerOf(added!)).toBe("guest");
      expect(rattata().caughtCount).toBe(0);
      expect(rattata().caughtAttr).toBe(0n);
    });

    it("adds it right away when the chooser has room, however many the partner has", async () => {
      await start("host", 4);
      const caught = enemy();
      await catchPokemon(caught, null, PokeballType.POKEBALL, false);

      expect(partyIds()).toContain(caught.id);
      expect(game.scene.getPlayerParty()).toHaveLength(5);
    });

    it("asks the chooser with three pokemon to make room", async () => {
      await start("host", 3);
      const caught = enemy();
      const done = catchPokemon(caught, null, PokeballType.POKEBALL, false);
      await waitForCoop(() => game.scene.ui.mode === UiMode.OPTION_SELECT);

      const handler = game.scene.ui.getHandler() as OptionSelectUiHandler;
      handler.setCursor(3); // "No": let it go
      handler.processInput(Button.ACTION);
      await done;
      expect(partyIds()).not.toContain(caught.id);
    });

    it("applies the chooser's choice on the other client", async () => {
      const partner = await start("guest", 3);
      const before = partyIds();
      const released = game.scene.getPlayerParty().find(p => ownerOf(p) === "host" && !p.isOnField())!;
      const caught = enemy();
      const done = catchPokemon(caught, null, PokeballType.POKEBALL, false);
      await waitForCoop(() => coopSession!.inputs.waiting);
      expect(game.scene.ui.mode).not.toBe(UiMode.OPTION_SELECT);

      const insertIndex = before.indexOf(released.id);
      partner.sendDecision({ kind: "capture", seq: firstSeq, action: "replace", releasedId: released.id, insertIndex });
      await done;

      expect(partyIds()).toEqual(before.map(id => (id === released.id ? caught.id : id)));
      expect(ownerOf(game.scene.getPlayerParty()[insertIndex])).toBe("host");
    });

    it("lets the other client keep the catch out too", async () => {
      const partner = await start("guest", 3);
      const before = partyIds();
      const done = catchPokemon(enemy(), null, PokeballType.POKEBALL, false);
      await waitForCoop(() => coopSession!.inputs.waiting);
      partner.sendDecision({ kind: "capture", seq: firstSeq, action: "keepOut" });
      await done;

      expect(partyIds()).toEqual(before);
    });
  });

  describe("pokemon that replace a party member", () => {
    const WAVE = 45;

    beforeEach(() => {
      game.override.startingWave(WAVE).enemySpecies(null);
    });

    async function startEncounter(encounter: MysteryEncounterType): Promise<CoopTestPartner> {
      const partner = new CoopTestPartner("host");
      await startCoopEncounter(game, {
        role: "host",
        start: startInfo([SpeciesId.BULBASAUR]),
        transport: partner.localTransport,
        encounter,
      });
      // The partner allows whatever the host asks about.
      partner.onReceive(message => {
        if (message.t === "choice" && message.kind === "optionAsk") {
          const { seq } = message.payload as { seq: number };
          partner.send({ t: "confirm", kind: "meOption", wave: WAVE, seq, accepted: true });
        }
      });
      return partner;
    }

    /** As the picker, take the encounter's first option. */
    const takeFirstOption = () => game.scene.ui.getHandler<MysteryEncounterUiHandler>().processInput(Button.ACTION);

    /** Go through the option's messages to its rewards. */
    async function finishOption(): Promise<void> {
      game.onNextPrompt(
        "MysteryEncounterOptionSelectedPhase",
        UiMode.MESSAGE,
        () => game.scene.ui.getHandler<MysteryEncounterUiHandler>().processInput(Button.ACTION),
        () => game.isCurrentPhase("MysteryEncounterRewardsPhase"),
      );
      await game.phaseInterceptor.to("MysteryEncounterRewardsPhase");
    }

    it("gives the traded pokemon to the owner of the one traded away", async () => {
      await startEncounter(MysteryEncounterType.GLOBAL_TRADE_SYSTEM);
      const [host, guest] = game.scene.getPlayerParty();
      takeFirstOption();
      // Trade the host's own pokemon (no need to ask the owner), for the first offer.
      await waitForCoop(() => game.scene.ui.mode === UiMode.PARTY);
      const partyUi = game.scene.ui.getHandler() as PartyUiHandler;
      partyUi.setCursor(0);
      partyUi.processInput(Button.ACTION);
      partyUi.processInput(Button.ACTION);
      await waitForCoop(() => game.scene.ui.mode === UiMode.OPTION_SELECT);
      const offers = game.scene.ui.getHandler() as OptionSelectUiHandler;
      offers["unblockInput"]();
      offers.setCursor(0);
      offers.processInput(Button.ACTION);
      await finishOption();

      const party = game.scene.getPlayerParty();
      expect(party.map(p => p.id)).not.toContain(host.id);
      const received = party.find(p => p.id !== guest.id)!;
      expect(ownerOf(received)).toBe("host");
      expect(ownerOf(guest)).toBe("guest");
    });

    it("keeps each transformed pokemon with its owner and its records on the owner's account", async () => {
      vi.spyOn(EncounterTransformationSequence, "doPokemonTransformationSequence").mockResolvedValue();
      await startEncounter(MysteryEncounterType.WEIRD_DREAM);
      const before = game.scene.getPlayerParty().map(p => ({ id: p.id, owner: ownerOf(p) }));
      // An account that caught everything gets a candy and an egg move for each pokemon it is credited with.
      for (const entry of Object.values(game.scene.gameData.dexData)) {
        entry.caughtAttr ||= 1n;
      }
      const dexBefore = structuredClone(game.scene.gameData.dexData);
      const starterBefore = structuredClone(game.scene.gameData.starterData);
      takeFirstOption();
      await finishOption();

      const after = game.scene.getPlayerParty();
      expect(after.map(p => p.id)).not.toEqual(before.map(p => p.id));
      expect(after.map(ownerOf).sort()).toEqual(before.map(p => p.owner).sort());
      const guestNew = after.find(p => ownerOf(p) === "guest")!;
      const root = guestNew.species.getRootSpeciesId();
      expect(game.scene.gameData.dexData[guestNew.species.speciesId].caughtCount).toBe(
        dexBefore[guestNew.species.speciesId].caughtCount,
      );
      expect(game.scene.gameData.starterData[root].candyCount).toBe(starterBefore[root].candyCount);
      expect(game.scene.gameData.starterData[root].eggMoves).toBe(starterBefore[root].eggMoves);
      // The host's own transformed pokemon is credited to the host's account.
      const hostRoot = after.find(p => ownerOf(p) === "host")!.species.getRootSpeciesId();
      expect(game.scene.gameData.starterData[hostRoot].candyCount).toBeGreaterThan(starterBefore[hostRoot].candyCount);
    });
  });

  describe("Training Session", () => {
    const WAVE = 45;

    it("unlocks the trained nature on the owner's account only", async () => {
      game.override.startingWave(WAVE).enemySpecies(null);
      const partner = new CoopTestPartner("host");
      await startCoopEncounter(game, {
        role: "host",
        start: startInfo([SpeciesId.BULBASAUR]),
        transport: partner.localTransport,
        encounter: MysteryEncounterType.TRAINING_SESSION,
      });
      partner.onReceive(message => {
        if (message.t === "choice" && message.kind === "ownerAsk") {
          const { seq } = message.payload as { seq: number };
          partner.send({ t: "confirm", kind: "mePokemon", wave: WAVE, seq, accepted: true });
        }
      });
      const dex = game.scene.gameData.dexData;
      dex[SpeciesId.CHARMANDER].caughtAttr ||= 1n;
      dex[SpeciesId.CHARMANDER].natureAttr = 0;
      const guest = game.scene.getPlayerParty()[1];
      expect(ownerOf(guest)).toBe("guest");

      // The second option trains the guest's pokemon for a new nature.
      const encounterUi = game.scene.ui.getHandler<MysteryEncounterUiHandler>();
      encounterUi.processInput(Button.RIGHT);
      encounterUi.processInput(Button.ACTION);
      await waitForCoop(() => game.scene.ui.mode === UiMode.PARTY);
      const partyUi = game.scene.ui.getHandler() as PartyUiHandler;
      partyUi.setCursor(1);
      partyUi.processInput(Button.ACTION);
      partyUi.processInput(Button.ACTION);
      await waitForCoop(() => game.scene.ui.mode === UiMode.OPTION_SELECT);
      const natures = game.scene.ui.getHandler() as OptionSelectUiHandler;
      natures["unblockInput"]();
      natures.setCursor(0);
      natures.processInput(Button.ACTION);
      game.onNextPrompt(
        "MysteryEncounterOptionSelectedPhase",
        UiMode.MESSAGE,
        () => game.scene.ui.getHandler<MysteryEncounterUiHandler>().processInput(Button.ACTION),
        () => game.isCurrentPhase("MysteryEncounterBattlePhase"),
      );
      await game.phaseInterceptor.to("MysteryEncounterBattlePhase", false);
      await skipBattleRunMysteryEncounterRewardsPhase(game, false);
      await game.phaseInterceptor.to("MysteryEncounterRewardsPhase");

      expect(game.scene.getPlayerParty().some(p => p.id === guest.id)).toBe(true);
      expect(dex[SpeciesId.CHARMANDER].natureAttr).toBe(0);
    });
  });
});
