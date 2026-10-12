import type { CoopAccountSnapshot, CoopMessage } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { getPlayerShopModifierTypeOptionsForWave } from "#modifiers/modifier-type";
import { GameManager } from "#test/framework/game-manager";
import { type CoopTestPartner, waitForCoop } from "#test/utils/coop-partner";
import { createTestStarterPayload, toCoopRewardScreen } from "#test/utils/coop-replay";
import type { ModifierSelectUiHandler } from "#ui/modifier-select-ui-handler";
import type { PartyUiHandler } from "#ui/party-ui-handler";
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
  seed: "coop-shop",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

type RewardMessage = Extract<CoopMessage, { t: "reward" }>;

/** The shop at wave 3 is Potion, Ether, Revive. */
const POTION = 0;
const WAVE = 3;

describe("co-op shop", () => {
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
      .itemRewards([{ name: "EXP_SHARE" }, { name: "EXP_SHARE" }, { name: "EXP_SHARE" }]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  const handler = () => game.scene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler;
  const potionCost = () => getPlayerShopModifierTypeOptionsForWave(WAVE, game.scene.getWaveMoneyAmount(1))[POTION].cost;
  const rewardEvents = (partner: CoopTestPartner) =>
    partner.received.filter((m): m is RewardMessage => m.t === "reward");
  const hurt = () => {
    for (const pokemon of game.scene.getPlayerParty()) {
      pokemon.hp = 1;
    }
  };

  /** Buy a potion from the shop row for a party slot through the screens. */
  async function buyPotion(slot: number): Promise<void> {
    handler().setRowCursor(2);
    handler().setCursor(POTION);
    handler().processInput(Button.ACTION);
    await waitForCoop(() => game.scene.ui.mode === UiMode.PARTY);
    const party = game.scene.ui.getHandler() as PartyUiHandler;
    party.setCursor(slot);
    party.processInput(Button.ACTION);
    party.processInput(Button.ACTION);
    await waitForCoop(() => game.scene.ui.mode === UiMode.MODIFIER_SELECT);
  }

  function potionEvent(by: "host" | "guest", req: number, slot: number, seq?: number): RewardMessage {
    return {
      t: "reward",
      wave: WAVE,
      gen: 0,
      req,
      by,
      action: { kind: "shop", option: POTION, slot, partyOption: 3 },
      ...(seq === undefined ? {} : { seq }),
    };
  }

  it("lets the waiting player buy, paying once when the host orders it", async () => {
    const partner = await toCoopRewardScreen(game, "guest", WAVE, startInfo());
    hurt();
    game.scene.money = 1000;
    await buyPotion(0);
    await waitForCoop(() => rewardEvents(partner).length > 0);

    expect(rewardEvents(partner)).toEqual([potionEvent("guest", 0, 0)]);
    expect(game.scene.money).toBe(1000);
    partner.send({ ...rewardEvents(partner)[0], seq: 0 });
    await waitForCoop(() => game.scene.money < 1000);

    expect(game.scene.money).toBe(1000 - potionCost());
    expect(game.scene.getPlayerParty()[0].hp).toBeGreaterThan(1);
  });

  it("numbers simultaneous buys in the order the host takes them", async () => {
    const partner = await toCoopRewardScreen(game, "host", WAVE, startInfo());
    hurt();
    game.scene.money = 1000;
    partner.send(potionEvent("guest", 0, 1));
    await buyPotion(0);
    await waitForCoop(() => rewardEvents(partner).length === 2);

    expect(rewardEvents(partner)).toEqual([potionEvent("guest", 0, 1, 0), potionEvent("host", 0, 0, 1)]);
    expect(game.scene.money).toBe(1000 - 2 * potionCost());
    expect(game.scene.getPlayerParty().every(p => p.hp > 1)).toBe(true);
  });

  it("rejects a buy the wallet no longer covers on both clients", async () => {
    const partner = await toCoopRewardScreen(game, "guest", WAVE, startInfo());
    hurt();
    game.scene.money = potionCost();
    await buyPotion(1);
    await waitForCoop(() => rewardEvents(partner).length > 0);
    // The host bought first and the guest's buy came second.
    partner.send(potionEvent("host", 0, 0, 0));
    partner.send({ ...rewardEvents(partner)[0], seq: 1 });
    await waitForCoop(() => game.textInterceptor.logs.includes(coopText("notEnoughMoney")));

    expect(game.scene.money).toBe(0);
    expect(game.scene.getPlayerParty()[0].hp).toBeGreaterThan(1);
    expect(game.scene.getPlayerParty()[1].hp).toBe(1);
  });

  it("drops buys ordered after the picker closed the screen", async () => {
    const partner = await toCoopRewardScreen(game, "guest", WAVE, startInfo());
    hurt();
    game.scene.money = 1000;
    partner.send({ t: "reward", wave: WAVE, gen: 0, req: 0, by: "host", seq: 0, action: { kind: "skip" } });
    partner.send(potionEvent("guest", 0, 0, 1));
    await game.phaseInterceptor.to("CommandPhase");

    expect(game.scene.money).toBe(1000);
    expect(game.scene.getPlayerParty()[0].hp).toBe(1);
  });
});
