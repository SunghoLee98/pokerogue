import { beginCoopSession, createCoopGameMode } from "#coop/coop-game-start";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { BattleStyle } from "#enums/battle-style";
import { BattleType } from "#enums/battle-type";
import { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import * as MysteryEncounters from "#mystery-encounters/mystery-encounter-biomes";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { answerWaveStartSwitchPrompt, createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import { runMysteryEncounterToEnd } from "#test/utils/encounter-test-utils";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

function startInfo(host: SpeciesId[], guest: SpeciesId[]): CoopStartInfo {
  return {
    seed: "coop-switch-question",
    accounts: { host: snapshot(1), guest: snapshot(2) },
    picks: { host: host.map(createTestStarterPayload), guest: guest.map(createTestStarterPayload) },
    timedEvent: null,
  };
}

const BOTH_BENCHES = {
  host: [SpeciesId.BULBASAUR, SpeciesId.PIDGEY],
  guest: [SpeciesId.CHARMANDER, SpeciesId.RATTATA],
};

/** The wave start "switch?" answers the local client sent. */
function sentAnswers(partner: CoopTestPartner): unknown[] {
  return partner.received
    .filter((m): m is Extract<CoopMessage, { t: "choice" }> => m.t === "choice" && m.kind === "waveStartSwitch")
    .map(m => m.payload);
}

describe("co-op wave start switch question", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingWave(3)
      .startingLevel(100)
      .enemyLevel(2)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH, MoveId.HYPER_VOICE]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  interface StartOptions {
    role: CoopRole;
    style: BattleStyle;
    host?: SpeciesId[];
    guest?: SpeciesId[];
    /** The party slot the local player sends out when asked (Switch style only) */
    localSwitch?: number;
    /** The partner's answer */
    partnerSwitch?: (party: ReturnType<typeof partyBySpecies>) => number | null;
  }

  /** Party slots by species, once the starters exist. */
  function partyBySpecies() {
    const party = game.scene.getPlayerParty();
    return (species: SpeciesId) => party.findIndex(p => p.species.speciesId === species);
  }
  let confirms: number;
  /** The arguments of each party screen opened */
  let partyScreens: unknown[][];

  async function start(options: StartOptions): Promise<CoopTestPartner> {
    game.settings.battleStyle(options.style);
    const partner = new CoopTestPartner(options.role);
    partner.waveStartSwitch = () => options.partnerSwitch?.(partyBySpecies()) ?? null;
    confirms = 0;
    partyScreens = [];
    const setMode = game.scene.ui.setMode.bind(game.scene.ui);
    vi.spyOn(game.scene.ui, "setMode").mockImplementation((mode, ...args) => {
      if (mode === UiMode.CONFIRM && game.isCurrentPhase("CheckSwitchPhase")) {
        confirms++;
      }
      if (mode === UiMode.PARTY) {
        partyScreens.push(args);
      }
      return setMode(mode, ...args);
    });
    await startCoopBattle(game, {
      role: options.role,
      start: startInfo(options.host ?? BOTH_BENCHES.host, options.guest ?? BOTH_BENCHES.guest),
      transport: partner.localTransport,
      waveStartSwitch: options.localSwitch ?? null,
    });
    return partner;
  }

  const field = () => game.scene.getPlayerField().map(p => p.species.speciesId);

  it("asks the host only about the host's pokemon", async () => {
    const partner = await start({ role: "host", style: BattleStyle.SWITCH });

    expect(confirms).toBe(1);
    expect(game.phaseInterceptor.phaseLog.filter(p => p === "CheckSwitchPhase")).toHaveLength(2);
    expect(sentAnswers(partner)).toEqual([{ kind: "waveStartSwitch", seq: 0, slotIndex: -1 }]);
    expect(field()).toEqual([SpeciesId.BULBASAUR, SpeciesId.CHARMANDER]);
  });

  it("asks the guest only about the guest's pokemon, after the host answered", async () => {
    const partner = await start({ role: "guest", style: BattleStyle.SWITCH });

    expect(confirms).toBe(1);
    expect(sentAnswers(partner)).toEqual([{ kind: "waveStartSwitch", seq: 1, slotIndex: -1 }]);
    expect(coopSession?.decisionCount).toBe(2);
  });

  it("does not ask a player with the Set battle style, and tells the partner so", async () => {
    const partner = await start({ role: "host", style: BattleStyle.SET });

    expect(confirms).toBe(0);
    expect(sentAnswers(partner)).toEqual([{ kind: "waveStartSwitch", seq: 0, slotIndex: -1 }]);
    expect(game.phaseInterceptor.phaseLog).toContain("CommandPhase");
  });

  it("applies the partner's switch while the local player keeps the Set battle style", async () => {
    const showText = vi.spyOn(game.scene.ui, "showText");
    await start({ role: "host", style: BattleStyle.SET, partnerSwitch: slotOf => slotOf(SpeciesId.RATTATA) });

    expect(field()).toEqual([SpeciesId.BULBASAUR, SpeciesId.RATTATA]);
    expect(game.scene.getPlayerField().every(p => p.isOnField())).toBe(true);
    expect(showText.mock.calls.map(call => call[0])).toContain(coopText("waitingForPartnerChoice"));
  });

  it("lets the owner switch to their own pokemon and sends the choice", async () => {
    // The party is ordered host, guest, then the benches: Bulbasaur, Charmander, Pidgey, Rattata.
    const partner = await start({ role: "guest", style: BattleStyle.SWITCH, localSwitch: 3 });

    expect(field()).toEqual([SpeciesId.BULBASAUR, SpeciesId.RATTATA]);
    expect(sentAnswers(partner)).toEqual([{ kind: "waveStartSwitch", seq: 1, slotIndex: 3 }]);
    // The party screen is one where only the player's own pokemon can be sent out.
    expect(partyScreens).toHaveLength(1);
    expect(partyScreens[0][0]).toBe(PartyUiMode.POST_BATTLE_SWITCH);
    expect(partyScreens[0][1]).toBe(1);
  });

  it("does not ask a player without a pokemon to switch to", async () => {
    const partner = await start({ role: "host", style: BattleStyle.SWITCH, host: [SpeciesId.BULBASAUR] });

    expect(confirms).toBe(0);
    expect(sentAnswers(partner)).toEqual([]);
    // Only the guest's question used a decision number.
    expect(coopSession?.decisionCount).toBe(1);
  });

  it("does not ask in trainer battles", async () => {
    // The rival battle, a fixed trainer battle.
    game.override.startingWave(8);
    const partner = await start({ role: "host", style: BattleStyle.SWITCH });

    expect(game.scene.currentBattle.battleType).toBe(BattleType.TRAINER);
    expect(confirms).toBe(0);
    expect(sentAnswers(partner)).toEqual([]);
    expect(game.phaseInterceptor.phaseLog).not.toContain("CheckSwitchPhase");
  });

  it("asks again at the start of the next wave", async () => {
    const partner = await start({ role: "host", style: BattleStyle.SWITCH });
    game.move.select(MoveId.HYPER_VOICE, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SPLASH));
    await game.toEndOfTurn();
    expect(game.isVictory()).toBe(true);
    // As `toNextWave`, answering the question after the reward screen.
    game.doSelectModifier();
    answerWaveStartSwitchPrompt(game, null);
    await game.phaseInterceptor.to("TurnInitPhase");
    await game.phaseInterceptor.to("CommandPhase");

    expect(confirms).toBe(2);
    expect(sentAnswers(partner)).toEqual([
      { kind: "waveStartSwitch", seq: 0, slotIndex: -1 },
      { kind: "waveStartSwitch", seq: 2, slotIndex: -1 },
    ]);
  });

  describe("in mystery encounter battles", () => {
    /** Start a co-op session as the host on a solo run that reached the encounter, both players with a bench. */
    async function toEncounter(encounter: MysteryEncounterType, biome: BiomeId): Promise<CoopTestPartner> {
      game.override.mysteryEncounterChance(100).startingWave(45).startingBiome(biome);
      vi.spyOn(MysteryEncounters, "mysteryEncountersByBiome", "get").mockReturnValue(
        new Map<BiomeId, MysteryEncounterType[]>([[biome, [encounter]]]),
      );
      await game.runToMysteryEncounter(encounter, [
        SpeciesId.BULBASAUR,
        SpeciesId.CHARMANDER,
        SpeciesId.PIDGEY,
        SpeciesId.RATTATA,
      ]);
      game.scene.gameMode = createCoopGameMode();
      const partner = new CoopTestPartner("host");
      const session = beginCoopSession("host", partner.localTransport, startInfo([], []));
      for (const [index, pokemon] of game.scene.getPlayerParty().entries()) {
        session.ownership.set(pokemon.id, index % 2 === 0 ? "host" : "guest");
      }
      game.phaseInterceptor.clearLogs();
      return partner;
    }

    it("asks each player about their own pokemon in a wild battle", async () => {
      const partner = await toEncounter(MysteryEncounterType.FIGHT_OR_FLIGHT, BiomeId.CAVE);
      await runMysteryEncounterToEnd(game, 1, undefined, true);

      expect(game.phaseInterceptor.phaseLog.filter(p => p === "CheckSwitchPhase")).toHaveLength(2);
      expect(sentAnswers(partner)).toEqual([{ kind: "waveStartSwitch", seq: 0, slotIndex: -1 }]);
    });

    it("does not ask in a trainer battle", async () => {
      const partner = await toEncounter(MysteryEncounterType.MYSTERIOUS_CHALLENGERS, BiomeId.CAVE);
      await runMysteryEncounterToEnd(game, 1, undefined, true);

      expect(game.scene.currentBattle.trainer).toBeDefined();
      expect(game.phaseInterceptor.phaseLog).not.toContain("CheckSwitchPhase");
      expect(sentAnswers(partner)).toEqual([]);
    });
  });
});
