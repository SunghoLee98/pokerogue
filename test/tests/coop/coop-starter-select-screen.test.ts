import { leaveCoop, openCoopLobby } from "#coop/coop-lobby";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Button } from "#enums/buttons";
import { Nature } from "#enums/nature";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { createTestStarterPayload } from "#test/utils/coop-replay";
import type { Starter } from "#types/save-data";
import type { ConfirmModeConfig } from "#types/ui-types";
import type { StarterSelectUiHandler } from "#ui/starter-select-ui-handler";
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

// The starter select screen cannot be shown headless (see `coop-starter-select-ui.test.ts`), so these tests set up
// the parts of the real handler that the co-op flow touches and drive them directly.
describe("co-op on the starter select screen", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let handler: StarterSelectUiHandler;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    handler["coopUi"]?.destroy();
    handler["coopUi"] = null;
    handler["partyStarters"].splice(0);
    handler.partyStarterIds.splice(0);
    handler.clearText();
    leaveCoop();
    vi.restoreAllMocks();
  });

  async function setUp() {
    game = new GameManager(phaserGame);
    handler = game.scene.ui.handlers[UiMode.STARTER_SELECT] as StarterSelectUiHandler;
    const pair = createLoopbackPair();
    await pair.host.host();
    await pair.guest.join("LOOP00");
    const lobby = openCoopLobby(
      { role: "guest", transport: pair.guest, peerAccountName: "Hosty", peerTrainerId: 0, peerResume: false },
      { getAccount: () => emptySnapshot },
    );
    const container = handler["starterSelectContainer"];
    const before = new Set(container.list);
    const addText = vi.spyOn(game.scene.add, "text");
    handler["setUpCoop"]();
    const added = container.list.filter(child => !before.has(child));
    handler["partyStarters"].push(starter(SpeciesId.CHARMANDER));
    handler.partyStarterIds.push(SpeciesId.CHARMANDER);

    const { ui } = game.scene;
    vi.spyOn(ui, "showText").mockImplementation((text, _delay, callback) => {
      handler.showText(text, 0);
      callback?.();
    });
    const confirms: ConfirmModeConfig[] = [];
    vi.spyOn(ui, "setModeWithoutClear").mockImplementation((mode, config) => {
      if (mode === UiMode.CONFIRM) {
        confirms.push(config);
      }
      return Promise.resolve();
    });
    vi.spyOn(ui, "setMode").mockResolvedValue();
    return { pair, lobby, confirms, added, addText };
  }

  const messageBoxVisible = () => handler["starterSelectMessageBoxContainer"].visible;

  it("closes the start prompt once the player is ready", async () => {
    const { lobby, confirms } = await setUp();

    handler["tryStart"](true);
    expect(messageBoxVisible()).toBe(true);
    confirms[0].yesHandler();

    expect(lobby.selection.localReady).toBe(true);
    expect(messageBoxVisible()).toBe(false);

    handler.processInput(Button.CANCEL);
    expect(lobby.selection.localReady).toBe(false);
    expect(messageBoxVisible()).toBe(false);
  });

  it("hides the empty slot placeholder behind the partner's picks", async () => {
    const { pair } = await setUp();
    const placeholders = handler["partyIcons"].slice(3);
    // Headless sprites do not keep their visibility, so this follows the last `setVisible` call (visible by default)
    const setVisible = placeholders.map(icon => vi.spyOn(icon, "setVisible"));
    const visible = () => setVisible.map(spy => spy.mock.lastCall?.[0] ?? true);
    expect(visible()).toEqual([true, true, true]);

    pair.host.send({
      t: "starters",
      picks: [createTestStarterPayload(SpeciesId.PIKACHU)],
      ready: true,
      account: emptySnapshot,
    });
    await flush();
    expect(visible()).toEqual([false, true, true]);

    pair.host.send({ t: "starters", picks: [], ready: false, account: emptySnapshot });
    await flush();
    expect(visible()).toEqual([true, true, true]);

    pair.host.send({
      t: "starters",
      picks: [createTestStarterPayload(SpeciesId.PIKACHU)],
      ready: true,
      account: emptySnapshot,
    });
    await flush();
    handler["coopUi"]?.destroy();
    handler["coopUi"] = null;
    expect(visible()).toEqual([true, true, true]);
  });

  it("keeps the co-op status clear of the message box", async () => {
    const { added, addText } = await setUp();
    const container = handler["starterSelectContainer"];
    const messageBox = handler["starterSelectMessageBoxContainer"];
    const status = added.find(child => "setText" in child);
    expect(status).toBeDefined();

    // Drawn under the message box and the overlays, so they cover it rather than the other way round
    expect(added).toHaveLength(4);
    for (const child of added) {
      for (const above of [messageBox, handler["filterBar"], handler["moveInfoOverlay"]]) {
        expect(container.getIndex(child)).toBeLessThan(container.getIndex(above));
      }
    }
    // ... and above a one-line message box (the start prompt), so it stays readable while answering
    // (headless text objects do not keep their position, so this reads the one they were created at)
    const statusCall = addText.mock.results.findIndex(result => result.value === status);
    const [, statusY] = addText.mock.calls[statusCall];
    const oneLineMessageBoxTop = game.scene.scaledCanvas.height - 1 - 28;
    expect(statusY + 7).toBeLessThanOrEqual(oneLineMessageBoxTop);
  });
});
