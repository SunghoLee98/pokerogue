import { coopLobby, leaveCoop, openCoopLobby } from "#coop/coop-lobby";
import type { CoopStarterPayload } from "#coop/coop-protocol";
import { coopSession } from "#coop/coop-session";
import {
  type CoopPartnerView,
  CoopStarterSelectController,
  createCoopStarterSelectUi,
} from "#coop/coop-starter-select-ui";
import { CoopStarterSelection } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Button } from "#enums/buttons";
import { Nature } from "#enums/nature";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { TitlePhase } from "#phases/title-phase";
import { GameManager } from "#test/framework/game-manager";
import { createTestStarterPayload } from "#test/utils/coop-replay";
import type { Starter } from "#types/save-data";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const emptySnapshot = { trainerId: 0, secretId: 0, caughtSpecies: [], eggMoves: {}, unlocks: [] };

function starter(speciesId: SpeciesId): Starter {
  return {
    speciesId,
    shiny: false,
    variant: 0,
    formIndex: 0,
    abilityIndex: 0,
    passive: false,
    nature: Nature.HARDY,
    pokerus: false,
    ivs: [20, 20, 20, 20, 20, 20],
  };
}

class FakePartnerView implements CoopPartnerView {
  partner: { picks: readonly CoopStarterPayload[]; ready: boolean } = { picks: [], ready: false };
  status = "";
  destroyed = false;

  setPartner(picks: readonly CoopStarterPayload[], ready: boolean): void {
    this.partner = { picks, ready };
  }

  setStatus(text: string): void {
    this.status = text;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

async function connectedPair(): Promise<{ host: CoopTransport; guest: CoopTransport }> {
  const pair = createLoopbackPair();
  await pair.host.host();
  await pair.guest.join("LOOP00");
  return pair;
}

describe("CoopStarterSelectController", () => {
  const cleanUps: (() => void)[] = [];

  afterEach(() => {
    for (const cleanUp of cleanUps.splice(0)) {
      cleanUp();
    }
  });

  async function setUp() {
    const pair = await connectedPair();
    const local = new CoopStarterSelection("guest", pair.guest, { getAccount: () => emptySnapshot });
    const partner = new CoopStarterSelection("host", pair.host, {
      getAccount: () => emptySnapshot,
      createSeed: () => "seed",
      getTimedEvent: () => null,
    });
    const view = new FakePartnerView();
    const started: Starter[][] = [];
    const controller = new CoopStarterSelectController(
      local,
      view,
      starters => started.push(starters),
      s => createTestStarterPayload(s.speciesId),
    );
    cleanUps.push(() => {
      controller.destroy();
      local.dispose();
      partner.dispose();
    });
    return { pair, local, partner, view, started, controller };
  }

  it("confirming sends ready instead of starting", async () => {
    const { partner, view, started, controller } = await setUp();

    expect(controller.confirm([starter(SpeciesId.CHARMANDER)])).toBe(true);
    await flush();

    expect(partner.partner).toEqual({ picks: [createTestStarterPayload(SpeciesId.CHARMANDER)], ready: true });
    expect(view.status).toBe(coopText("waitingForReady"));
    expect(started).toEqual([]);
  });

  it("cancel during ready unreadies", async () => {
    const { partner, controller } = await setUp();
    expect(controller.processInput(Button.CANCEL)).toBe(false);

    controller.confirm([starter(SpeciesId.CHARMANDER)]);
    expect(controller.processInput(Button.ACTION)).toBe(true);
    expect(controller.processInput(Button.CANCEL)).toBe(true);
    await flush();

    expect(partner.partner).toEqual({ picks: [], ready: false });
    expect(controller.processInput(Button.CANCEL)).toBe(false);
  });

  it("shows the partner's confirmed picks", async () => {
    const { partner, view } = await setUp();
    expect(view.status).toBe(coopText("partnerPicking"));

    partner.setReady([createTestStarterPayload(SpeciesId.PIKACHU)]);
    await flush();

    expect(view.partner).toEqual({ picks: [createTestStarterPayload(SpeciesId.PIKACHU)], ready: true });
    expect(view.status).toBe(coopText("partnerReady"));
  });

  it("starts with the local starters when both are ready", async () => {
    const { partner, started, controller } = await setUp();
    controller.confirm([starter(SpeciesId.CHARMANDER), starter(SpeciesId.SQUIRTLE)]);
    partner.setReady([createTestStarterPayload(SpeciesId.PIKACHU)]);
    await flush();

    expect(started).toEqual([[starter(SpeciesId.CHARMANDER), starter(SpeciesId.SQUIRTLE)]]);
    expect(controller.processInput(Button.CANCEL)).toBe(true);
  });

  it("tells the player when the partner left", async () => {
    const { pair, local, view, controller } = await setUp();
    pair.host.close();
    await flush();

    expect(view.status).toBe(coopText("partnerLeft"));
    expect(controller.confirm([starter(SpeciesId.CHARMANDER)])).toBe(true);
    expect(local.localReady).toBe(false);
  });
});

describe("co-op starter select phase", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    leaveCoop();
  });

  it("adds the co-op controls to the screen only in a lobby", async () => {
    const game = new GameManager(phaserGame);
    const container = game.scene.add.container(0, 0);
    const add = vi.spyOn(container, "add");
    const layout = {
      iconPosition: (i: number): [number, number] => [0, i * 10],
      statusPosition: [0, 0] as [number, number],
    };
    expect(createCoopStarterSelectUi(container, layout, () => {})).toBeNull();
    expect(add).not.toHaveBeenCalled();

    const pair = await connectedPair();
    openCoopLobby(
      { role: "guest", transport: pair.guest, peerAccountName: "Hosty" },
      { getAccount: () => emptySnapshot },
    );
    const controller = createCoopStarterSelectUi(container, layout, () => {});
    expect(controller).toBeInstanceOf(CoopStarterSelectController);
    const [added] = add.mock.calls[0] as [Phaser.GameObjects.GameObject[]];
    expect(added).toHaveLength(4);
    const icons = added.slice(0, 3) as Phaser.GameObjects.Sprite[];
    const setVisible = icons.map(icon => vi.spyOn(icon, "setVisible"));

    pair.host.send({
      t: "starters",
      picks: [createTestStarterPayload(SpeciesId.PIKACHU)],
      ready: true,
      account: emptySnapshot,
    });
    await flush();

    expect(setVisible.map(spy => spy.mock.lastCall?.[0])).toEqual([true, false, false]);
    controller?.destroy();
  });

  // The starter select screen itself cannot be shown headless (its starter containers need a renderer, which is
  // also why `test/tests/ui/starter-select.test.ts` is a todo), so this drives the phase through the callback the
  // screen calls once the co-op controller sees the run start.
  it("starts the run from the lobby instead of picking a save slot", async () => {
    const game = new GameManager(phaserGame);
    game.override.battleStyle("double").disableTrainerWaves();
    await game.runToTitle();
    const pair = await connectedPair();
    const lobby = openCoopLobby(
      { role: "guest", transport: pair.guest, peerAccountName: "Hosty" },
      { getAccount: () => emptySnapshot },
    );
    const host = new CoopStarterSelection("host", pair.host, {
      getAccount: () => emptySnapshot,
      createSeed: () => "seed",
      getTimedEvent: () => null,
    });
    const { ui } = game.scene;
    const setMode = vi.spyOn(ui, "setMode");

    game.onNextPrompt("TitlePhase", UiMode.TITLE, () => {
      (game.scene.phaseManager.getCurrentPhase() as TitlePhase).end();
    });
    await game.phaseInterceptor.to("SelectStarterPhase");
    expect(game.scene.gameMode.isCoop).toBe(true);
    const starterSelectCall = setMode.mock.calls.find(([mode]) => mode === UiMode.STARTER_SELECT);
    const starterSelectCallback = starterSelectCall?.[1] as (starters: Starter[]) => void;
    expect(starterSelectCallback).toBeTypeOf("function");

    lobby.selection.setReady([createTestStarterPayload(SpeciesId.CHARMANDER)]);
    host.setReady([createTestStarterPayload(SpeciesId.BULBASAUR)]);
    await flush();
    starterSelectCallback([starter(SpeciesId.CHARMANDER)]);
    await game.phaseInterceptor.to("EncounterPhase");

    expect(setMode.mock.calls.some(([mode]) => mode === UiMode.SAVE_SLOT)).toBe(false);
    expect(coopLobby).toBeNull();
    expect(coopSession?.localRole).toBe("guest");
    expect(game.scene.getPlayerParty().map(p => p.species.speciesId)).toEqual([
      SpeciesId.BULBASAUR,
      SpeciesId.CHARMANDER,
    ]);
    host.dispose();
  });
});
