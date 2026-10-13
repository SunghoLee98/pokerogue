import type { CoopAccountSnapshot } from "#coop/coop-protocol";
import { submitCoopRewardAction } from "#coop/coop-reward";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { SelectModifierPhase } from "#phases/select-modifier-phase";
import { GameManager } from "#test/framework/game-manager";
import { createTestStarterPayload, toCoopRewardScreen } from "#test/utils/coop-replay";
import { PartyOption, type PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-party-order",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR), createTestStarterPayload(SpeciesId.PIDGEY)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER), createTestStarterPayload(SpeciesId.RATTATA)],
  },
  timedEvent: null,
});

// The party order is part of the shared state: reordering on one client would split the two games.
describe("co-op party order", () => {
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
      .startingLevel(100)
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.HYPER_VOICE, MoveId.SPLASH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function checkTeam(): Promise<PartyUiHandler> {
    await toCoopRewardScreen(game, "host", 1, startInfo());
    await game.scene.ui.setModeWithoutClear(UiMode.PARTY, PartyUiMode.CHECK);
    return game.scene.ui.getHandler() as PartyUiHandler;
  }

  it("the team check offers no reordering", async () => {
    const handler = await checkTeam();
    handler.setCursor(0);
    handler.processInput(Button.ACTION);

    expect(handler["options"]).not.toContain(PartyOption.SWITCH);
    handler.processInput(Button.CANCEL);
  });

  it("the reorder mode does not start", async () => {
    const handler = await checkTeam();
    const order = game.scene.getPlayerParty().map(p => p.id);

    // What the reorder button (and the reorder option) start.
    handler["startPartySwitch"](-1);
    handler["startPartySwitchSelection"](0);
    handler.setCursor(2);
    handler.processInput(Button.ACTION);

    expect(handler["partySwitchMode"]).toBe(false);
    expect(game.scene.getPlayerParty().map(p => p.id)).toEqual(order);
    handler.processInput(Button.CANCEL);
  });

  it("the next wave keeps the co-op arrangement instead of reordering by party order", async () => {
    await toCoopRewardScreen(game, "host", 1, startInfo());
    submitCoopRewardAction(game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase, { kind: "skip" });
    await game.phaseInterceptor.to("PartyReorderSwitchPhase", false);
    const onField = () =>
      game.scene
        .getPlayerParty()
        .filter(p => p.isOnField())
        .map(p => p.id);
    const leads = onField();
    // A party order that does not match the field, as after switches in support mode.
    const party = game.scene.getPlayerParty();
    party.unshift(...party.splice(3, 1));

    await game.phaseInterceptor.to("PartyReorderSwitchPhase");

    expect(onField()).toEqual(leads);
    expect(game.scene.phaseManager.getCurrentPhase().is("SummonPhase")).toBe(false);
    expect(game.scene.phaseManager.getCurrentPhase().is("ReturnPhase")).toBe(false);
  });
});
