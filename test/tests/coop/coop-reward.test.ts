import { getCoopBannerText } from "#coop/coop-banner";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { ExpShareModifier, TurnHealModifier } from "#modifiers/modifier";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand, waitForCoop } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import { PartyOption, type PartyUiHandler } from "#ui/party-ui-handler";
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
  seed: "coop-reward",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

type RewardMessage = Extract<CoopMessage, { t: "reward" }>;

describe("co-op reward turns", () => {
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
      .moveset([MoveId.HYPER_VOICE, MoveId.SPLASH])
      .itemRewards([{ name: "EXP_SHARE" }, { name: "LEFTOVERS" }, { name: "EXP_SHARE" }]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  const handler = () => game.scene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler;
  const expShares = () => game.scene.findModifiers(m => m instanceof ExpShareModifier).length;
  const rewardEvents = (partner: CoopTestPartner) =>
    partner.received.filter((m): m is RewardMessage => m.t === "reward");

  /** Start at `wave`, win it on the first turn and wait at the reward screen. */
  async function toRewardScreen(role: CoopRole, wave: number): Promise<CoopTestPartner> {
    game.override.startingWave(wave);
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    const local = role === "host" ? BattlerIndex.PLAYER : BattlerIndex.PLAYER_2;
    game.move.select(MoveId.HYPER_VOICE, local);
    partner.sendCommand(synthesizeMoveCommand(role === "host" ? 1 : 0, MoveId.SPLASH));
    await game.phaseInterceptor.to("SelectModifierPhase", false);
    await game.phaseInterceptor.to("SelectModifierPhase");
    await waitForCoop(() => game.scene.ui.mode === UiMode.MODIFIER_SELECT && handler()["awaitingActionInput"]);
    return partner;
  }

  /** Press the action button on a reward screen item. */
  function choose(row: number, cursor: number): void {
    handler().setRowCursor(row);
    handler().setCursor(cursor);
    handler().processInput(Button.ACTION);
  }

  const nextWave = async () => {
    await game.phaseInterceptor.to("CommandPhase");
  };

  it("lets the picker take a free reward and tells the partner", async () => {
    const partner = await toRewardScreen("host", 3);
    choose(1, 0);
    await nextWave();

    expect(expShares()).toBe(1);
    expect(rewardEvents(partner)).toEqual([
      { t: "reward", wave: 3, gen: 0, req: 0, by: "host", seq: 0, action: { kind: "reward", option: 0 } },
    ]);
  });

  it("turns the other player's reward choice into a ping", async () => {
    const partner = await toRewardScreen("guest", 3);
    expect(getCoopBannerText()).toBe(coopText("partnerPickingReward"));
    choose(1, 2);
    await waitForCoop(() => partner.received.some(m => m.t === "ping"));

    expect(expShares()).toBe(0);
    expect(game.scene.phaseManager.getCurrentPhase().is("SelectModifierPhase")).toBe(true);
    expect(partner.received.find(m => m.t === "ping")).toEqual({
      t: "ping",
      kind: "reward",
      payload: { row: 1, cursor: 2 },
    });
  });

  it("shows each player where the other's cursor is", async () => {
    const partner = await toRewardScreen("guest", 3);
    handler().setRowCursor(1);
    handler().setCursor(2);
    await waitForCoop(() =>
      partner.received.some(m => m.t === "cursor" && m.at?.screen === "reward" && m.at.row === 1 && m.at.cursor === 2),
    );
    expect(partner.received.filter(m => m.t === "cursor").at(-1)).toEqual({
      t: "cursor",
      at: { screen: "reward", gen: 0, row: 1, cursor: 2 },
    });

    partner.send({ t: "cursor", at: { screen: "reward", gen: 0, row: 1, cursor: 1 } });
    await waitForCoop(() => handler()["partnerCursorObj"]?.visible);
    const placement = handler()["getCursorPlacement"](1, 1);
    expect(handler()["partnerCursorObj"]).toMatchObject({ x: placement.x, y: placement.y });

    // A cursor on an older screen is not shown
    partner.send({ t: "cursor", at: { screen: "reward", gen: -1, row: 1, cursor: 0 } });
    await waitForCoop(() => !handler()["partnerCursorObj"]?.visible);
  });

  it("applies the picker's reward on the other client", async () => {
    const partner = await toRewardScreen("guest", 3);
    partner.send({ t: "reward", wave: 3, gen: 0, req: 0, by: "host", seq: 0, action: { kind: "reward", option: 2 } });
    await nextWave();

    expect(expShares()).toBe(1);
    expect(getCoopBannerText()).toBeNull();
  });

  it("sends the guest's pick to the host and applies it once the host orders it", async () => {
    const partner = await toRewardScreen("guest", 4);
    expect(getCoopBannerText()).toBeNull();
    choose(1, 0);
    await waitForCoop(() => rewardEvents(partner).length > 0);

    expect(rewardEvents(partner)).toEqual([
      { t: "reward", wave: 4, gen: 0, req: 0, by: "guest", action: { kind: "reward", option: 0 } },
    ]);
    expect(expShares()).toBe(0);
    partner.send({ ...rewardEvents(partner)[0], seq: 0 });
    await nextWave();
    expect(expShares()).toBe(1);
  });

  it("orders the guest's request on the host", async () => {
    const partner = await toRewardScreen("host", 4);
    partner.send({ t: "reward", wave: 4, gen: 0, req: 0, by: "guest", action: { kind: "reward", option: 0 } });
    await nextWave();

    expect(expShares()).toBe(1);
    expect(rewardEvents(partner)).toEqual([
      { t: "reward", wave: 4, gen: 0, req: 0, by: "guest", seq: 0, action: { kind: "reward", option: 0 } },
    ]);
  });

  it("gives a reward to the partner's pokemon", async () => {
    const partner = await toRewardScreen("host", 3);
    const charmander = game.scene.getPlayerParty()[1];
    choose(1, 1);
    await waitForCoop(() => game.scene.ui.mode === UiMode.PARTY);
    const party = game.scene.ui.getHandler() as PartyUiHandler;
    party.setCursor(1);
    party.processInput(Button.ACTION);
    party.processInput(Button.ACTION);
    await nextWave();

    const leftovers = game.scene.findModifiers(m => m instanceof TurnHealModifier);
    expect(leftovers.map(m => (m as TurnHealModifier).pokemonId)).toEqual([charmander.id]);
    expect(rewardEvents(partner).map(m => m.action)).toEqual([
      { kind: "reward", option: 1, slot: 1, partyOption: PartyOption.APPLY },
    ]);
  });

  it("waits until the reward screen is back before applying a reward picked for a pokemon", async () => {
    const partner = await toRewardScreen("host", 3);
    choose(1, 1);
    await waitForCoop(() => game.scene.ui.mode === UiMode.PARTY);
    // Leaving the party screen takes a transition: hold it.
    let finishTransition = () => {};
    const setMode = game.scene.ui.setMode.bind(game.scene.ui);
    vi.spyOn(game.scene.ui, "setMode").mockImplementation((mode, ...args) => {
      if (mode !== UiMode.MODIFIER_SELECT) {
        return setMode(mode, ...args);
      }
      return new Promise<void>(resolve => {
        finishTransition = () => setMode(mode, ...args).then(resolve);
      });
    });
    const party = game.scene.ui.getHandler() as PartyUiHandler;
    party.setCursor(1);
    party.processInput(Button.ACTION);
    party.processInput(Button.ACTION);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(rewardEvents(partner)).toEqual([]);
    finishTransition();
    await waitForCoop(() => rewardEvents(partner).length > 0);
    await nextWave();
    expect(game.scene.findModifiers(m => m instanceof TurnHealModifier)).toHaveLength(1);
  });

  it("rerolls only for the picker, once", async () => {
    const partner = await toRewardScreen("host", 3);
    game.scene.money = 1000;
    choose(0, 0);
    await waitForCoop(() => rewardEvents(partner).length > 0);
    await game.phaseInterceptor.to("SelectModifierPhase");

    expect(game.scene.money).toBe(750);
    expect(rewardEvents(partner).map(m => m.action)).toEqual([{ kind: "reroll" }]);
    expect(game.scene.phaseManager.getCurrentPhase()["rerollCount"]).toBe(1);
  });

  it("ignores the other player's reroll", async () => {
    const partner = await toRewardScreen("guest", 3);
    game.scene.money = 1000;
    choose(0, 0);
    await waitForCoop(() => partner.received.some(m => m.t === "ping"));

    expect(game.scene.money).toBe(1000);
    expect(game.scene.phaseManager.getCurrentPhase()["rerollCount"]).toBe(0);
  });

  it("applies the picker's reroll on the other client", async () => {
    const partner = await toRewardScreen("guest", 3);
    game.scene.money = 1000;
    partner.send({ t: "reward", wave: 3, gen: 0, req: 0, by: "host", seq: 0, action: { kind: "reroll" } });
    partner.send({ t: "reward", wave: 3, gen: 1, req: 1, by: "host", seq: 1, action: { kind: "skip" } });
    await nextWave();

    expect(game.scene.money).toBe(750);
    expect(expShares()).toBe(0);
  });

  it("marks a pinged reward on the picker's screen", async () => {
    const partner = await toRewardScreen("host", 3);
    partner.send({ t: "ping", kind: "reward", payload: { row: 1, cursor: 2 } });
    await waitForCoop(() =>
      handler()
        .options[2].getAll()
        .some(o => o.name === "coop-ping"),
    );

    expect(
      handler()
        .options[0].getAll()
        .some(o => o.name === "coop-ping"),
    ).toBe(false);
    expect(getCoopBannerText()).toBe(coopText("partnerPinged"));
    // The pointing finger and the rings
    const marker = handler()
      .options[2].getAll()
      .find(o => o.name === "coop-ping") as Phaser.GameObjects.Container;
    expect(marker.getAll()).toHaveLength(4);

    // A new ping moves the mark
    const destroy = vi.spyOn(marker, "destroy");
    partner.send({ t: "ping", kind: "reward", payload: { row: 1, cursor: 0 } });
    await waitForCoop(() =>
      handler()
        .options[0].getAll()
        .some(o => o.name === "coop-ping"),
    );
    expect(destroy).toHaveBeenCalled();
  });
});
