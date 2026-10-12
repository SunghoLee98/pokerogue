import { getCoopBannerText } from "#coop/coop-banner";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { BattlerIndex } from "#enums/battler-index";
import { BiomeId } from "#enums/biome-id";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { SwitchBiomePhase } from "#phases/switch-biome-phase";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import { getBiomeName } from "#utils/common";
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
  seed: "coop-biome",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

/** Wave 10 ends in the Badlands, which lead to the Desert and the Mountain; wave 10 is the guest's to pick. */
const WAVE = 10;

describe("co-op biome choice", () => {
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
      .startingWave(WAVE)
      .startingBiome(BiomeId.BADLANDS)
      .startingModifier([{ name: "MAP" }])
      .startingLevel(100)
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  /** Win wave 10 (a boss wave: no reward screen) and wait at the biome choice. */
  async function toBiomeChoice(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    game.move.select(MoveId.SPLASH, role === "host" ? BattlerIndex.PLAYER : BattlerIndex.PLAYER_2);
    partner.sendCommand(synthesizeMoveCommand(role === "host" ? 1 : 0, MoveId.SPLASH));
    // Killing both enemies runs the turn on to the end of the wave.
    await game.doKillOpponents();
    // The biome choice waits for input, so run on to the phase after it in the background.
    switched = game.phaseInterceptor.to("SwitchBiomePhase", false);
    await vi.waitUntil(() => game.scene.ui.mode === UiMode.OPTION_SELECT);
    return partner;
  }

  const optionSelect = () => game.scene.ui.getHandler() as OptionSelectUiHandler;
  const choose = (index: number) => {
    const handler = optionSelect();
    handler["unblockInput"]();
    handler.setCursor(index);
    handler.processInput(Button.ACTION);
  };
  let switched: Promise<void>;
  const nextBiome = async () => {
    await switched;
    return (game.scene.phaseManager.getCurrentPhase() as SwitchBiomePhase)["nextBiome"];
  };
  const choices = (partner: CoopTestPartner) =>
    partner.received.filter((m): m is Extract<CoopMessage, { t: "choice" }> => m.t === "choice");

  it("sends the picker's biome", async () => {
    const partner = await toBiomeChoice("guest");
    choose(1);

    expect(await nextBiome()).toBe(BiomeId.MOUNTAIN);
    expect(choices(partner).map(m => m.payload)).toEqual([{ kind: "option", seq: 0, index: 1 }]);
  });

  it("pings instead of choosing for the other player, then follows the picker", async () => {
    const partner = await toBiomeChoice("host");
    choose(1);
    await vi.waitUntil(() => partner.received.some(m => m.t === "ping"));

    expect(partner.received.find(m => m.t === "ping")).toEqual({ t: "ping", kind: "option", payload: { index: 1 } });
    expect(game.scene.phaseManager.getCurrentPhase().is("SelectBiomePhase")).toBe(true);
    partner.sendDecision({ kind: "option", seq: 0, index: 0 });
    expect(await nextBiome()).toBe(BiomeId.DESERT);
  });

  it("shows the partner's ping to the picker", async () => {
    const partner = await toBiomeChoice("guest");
    partner.send({ t: "ping", kind: "option", payload: { index: 0 } });
    await vi.waitUntil(() => getCoopBannerText() !== null);

    expect(getCoopBannerText()).toBe(coopText("partnerPingedOption", { option: getBiomeName(BiomeId.DESERT) }));
    choose(0);
    expect(await nextBiome()).toBe(BiomeId.DESERT);
    expect(getCoopBannerText()).toBeNull();
  });
});
