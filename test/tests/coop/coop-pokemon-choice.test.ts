import { getCoopBannerText } from "#coop/coop-banner";
import type { CoopAccountSnapshot, CoopDecision, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { EvolutionSceneUiHandler } from "#ui/evolution-scene-ui-handler";
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

/** The host owns Bulbasaur (slot 0) and Pidgey (slot 2); the guest owns Charmander (slot 1). */
const startInfo = (): CoopStartInfo => ({
  seed: "coop-pokemon-choice",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [SpeciesId.BULBASAUR, SpeciesId.PIDGEY].map(createTestStarterPayload),
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

const FOUR_MOVES = [MoveId.SPLASH, MoveId.TACKLE, MoveId.GROWL, MoveId.SCRATCH];

describe("co-op choices for one's own pokemon", () => {
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
      .startingLevel(20)
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    for (const pokemon of game.scene.getPlayerParty()) {
      game.move.changeMoveset(pokemon, FOUR_MOVES);
    }
    return partner;
  }

  /** Both players use Splash; the phase queued before runs once the commands are in. */
  function splashTurn(role: CoopRole, partner: CoopTestPartner): void {
    game.move.select(MoveId.SPLASH, role === "host" ? BattlerIndex.PLAYER : BattlerIndex.PLAYER_2);
    partner.sendCommand(synthesizeMoveCommand(role === "host" ? 1 : 0, MoveId.SPLASH));
  }

  const charmander = () => game.scene.getPlayerParty()[1];
  const decisions = (partner: CoopTestPartner) =>
    partner.received
      .filter((m): m is Extract<CoopMessage, { t: "choice" }> => m.t === "choice")
      .map(m => m.payload as CoopDecision);

  describe("learning a move", () => {
    it("lets the owner pick the move to forget and sends it", async () => {
      const partner = await start("guest");
      game.scene.phaseManager.unshiftNew("LearnMovePhase", 1, MoveId.EMBER);
      splashTurn("guest", partner);
      const turn = game.toEndOfTurn();
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.CONFIRM, { timeout: 10_000 });
      game.scene.ui.getHandler().processInput(Button.ACTION);
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.SUMMARY, { timeout: 10_000 });
      game.scene.ui.getHandler().setCursor(2);
      game.scene.ui.getHandler().processInput(Button.ACTION);
      await turn;
      await vi.waitUntil(() => decisions(partner).length > 0);

      expect(
        charmander()
          .getMoveset()
          .map(m => m.moveId),
      ).toEqual([MoveId.SPLASH, MoveId.TACKLE, MoveId.EMBER, MoveId.SCRATCH]);
      expect(decisions(partner)).toEqual([{ kind: "learnMove", seq: 0, moveIndex: 2 }]);
    });

    it("applies the owner's pick on the partner's client", async () => {
      const partner = await start("host");
      game.scene.phaseManager.unshiftNew("LearnMovePhase", 1, MoveId.EMBER);
      splashTurn("host", partner);
      await game.phaseInterceptor.to("LearnMovePhase", false);
      const learning = game.phaseInterceptor.to("LearnMovePhase");
      await vi.waitUntil(() => game.textInterceptor.logs.includes(coopText("waitingForPartnerChoice")));

      expect(game.scene.ui.mode).not.toBe(UiMode.CONFIRM);
      partner.sendDecision({ kind: "learnMove", seq: 0, moveIndex: 1 });
      await learning;
      expect(
        charmander()
          .getMoveset()
          .map(m => m.moveId),
      ).toEqual([MoveId.SPLASH, MoveId.EMBER, MoveId.GROWL, MoveId.SCRATCH]);
    });

    it("keeps the moves when the owner gives up learning", async () => {
      const partner = await start("host");
      game.scene.phaseManager.unshiftNew("LearnMovePhase", 1, MoveId.EMBER);
      partner.sendDecision({ kind: "learnMove", seq: 0, moveIndex: -1 });
      splashTurn("host", partner);
      await game.toEndOfTurn();

      expect(
        charmander()
          .getMoveset()
          .map(m => m.moveId),
      ).toEqual(FOUR_MOVES);
    });
  });

  describe("evolving", () => {
    function queueEvolution(pokemon: PlayerPokemon): void {
      const evolution = pokemon.getEvolution();
      game.scene.phaseManager.unshiftNew("EvolutionPhase", pokemon, evolution, pokemon.level - 1);
    }

    it("lets only the owner stop the evolution", async () => {
      const partner = await start("host");
      queueEvolution(charmander());
      partner.sendDecision({ kind: "evolution", seq: 0, cancelled: true, paused: false });
      partner.sendDecision({ kind: "evolution", seq: 1, cancelled: true, paused: true });
      splashTurn("host", partner);
      await game.phaseInterceptor.to("EvolutionPhase", false);
      const evolving = game.phaseInterceptor.to("EndEvolutionPhase");
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.EVOLUTION_SCENE);
      const handler = game.scene.ui.getHandler() as EvolutionSceneUiHandler;
      await vi.waitUntil(() => handler.canCancel || game.textInterceptor.logs.length > 0);
      expect(handler.canCancel).toBe(false);
      await evolving;

      expect(charmander().species.speciesId).toBe(SpeciesId.CHARMANDER);
      expect(charmander().pauseEvolutions).toBe(true);
    });

    it("sends the owner's choice to stop the evolution", async () => {
      const partner = await start("guest");
      queueEvolution(charmander());
      splashTurn("guest", partner);
      await game.phaseInterceptor.to("EvolutionPhase", false);
      // The owner presses cancel while the evolution animation cycles.
      const doCycle = game.scene.animations.doCycle.bind(game.scene.animations);
      vi.spyOn(game.scene.animations, "doCycle").mockImplementation((...args) => {
        game.scene.ui.handlers[UiMode.EVOLUTION_SCENE].processInput(Button.CANCEL);
        return doCycle(...args);
      });
      const evolving = game.phaseInterceptor.to("EndEvolutionPhase");
      // "Stopped evolving", then "pause evolutions?": yes.
      await vi.waitUntil(
        () => {
          const scene = game.scene.ui.handlers[UiMode.EVOLUTION_SCENE] as unknown as { awaitingActionInput: boolean };
          if (scene.awaitingActionInput) {
            game.scene.ui.handlers[UiMode.EVOLUTION_SCENE].processInput(Button.ACTION);
          }
          return game.scene.ui.mode === UiMode.CONFIRM;
        },
        { timeout: 10_000 },
      );
      game.scene.ui.getHandler().processInput(Button.ACTION);
      await evolving;

      expect(charmander().species.speciesId).toBe(SpeciesId.CHARMANDER);
      expect(decisions(partner)).toEqual([
        { kind: "evolution", seq: 0, cancelled: true, paused: false },
        { kind: "evolution", seq: 1, cancelled: true, paused: true },
      ]);
    });

    it("tells the partner when the owner lets it evolve", async () => {
      const partner = await start("guest");
      queueEvolution(charmander());
      splashTurn("guest", partner);
      await game.phaseInterceptor.to("EndEvolutionPhase");

      expect(charmander().species.speciesId).toBe(SpeciesId.CHARMELEON);
      expect(decisions(partner)).toEqual([{ kind: "evolution", seq: 0, cancelled: false, paused: false }]);
    });
  });

  describe("revival blessing", () => {
    it("is picked by the user's owner on their client", async () => {
      const partner = await start("guest");
      const pidgey = game.scene.getPlayerParty()[2];
      pidgey.hp = 0;
      pidgey.doSetStatus(StatusEffect.FAINT);
      game.scene.phaseManager.unshiftNew("RevivalBlessingPhase", charmander());
      splashTurn("guest", partner);
      const turn = game.toEndOfTurn();
      await vi.waitUntil(() => game.scene.ui.mode === UiMode.PARTY, { timeout: 10_000 });
      const party = game.scene.ui.getHandler() as PartyUiHandler;
      party.setCursor(2);
      party.processInput(Button.ACTION);
      party.processInput(Button.ACTION);
      await turn;

      expect(pidgey.isFainted()).toBe(false);
      expect(decisions(partner)).toMatchObject([{ kind: "partyPick", seq: 0, slotIndex: 2 }]);
    });

    it("is applied from the owner's pick on the partner's client", async () => {
      const partner = await start("host");
      const pidgey = game.scene.getPlayerParty()[2];
      pidgey.hp = 0;
      pidgey.doSetStatus(StatusEffect.FAINT);
      game.scene.phaseManager.unshiftNew("RevivalBlessingPhase", charmander());
      splashTurn("host", partner);
      await game.phaseInterceptor.to("RevivalBlessingPhase", false);
      const reviving = game.phaseInterceptor.to("RevivalBlessingPhase");
      await vi.waitUntil(() => getCoopBannerText() !== null || game.scene.ui.mode === UiMode.PARTY);

      expect(game.scene.ui.mode).not.toBe(UiMode.PARTY);
      partner.sendDecision({ kind: "partyPick", seq: 0, slotIndex: 2, option: 0 });
      await reviving;
      await game.toEndOfTurn();
      expect(pidgey.isFainted()).toBe(false);
    });
  });
});
