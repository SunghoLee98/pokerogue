import { getCoopBannerText } from "#coop/coop-banner";
import { coopExit } from "#coop/coop-exit";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { getCoopRewardGen } from "#coop/coop-reward";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { getCoopWaitButtonText } from "#coop/coop-wait-button";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand, waitForCoop } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle, toCoopRewardScreen } from "#test/utils/coop-replay";
import type { MenuUiHandler } from "#ui/menu-ui-handler";
import i18next from "i18next";
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
  seed: "coop-wait-button",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

const FIELD = { host: 0, guest: 1 } as const;

describe("save and quit while waiting for the partner", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let returnToTitle: ReturnType<typeof vi.fn>;
  const defaults = { ...coopExit };

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
      .moveset([MoveId.SPLASH]);
    // Saves are real here: the host keeps the save made at the start of the wave.
    vi.mocked(game.scene.gameData.saveAll).mockRestore();
    returnToTitle = vi.fn();
    Object.assign(coopExit, { returnToTitle, noticeMs: 0 });
  });

  afterEach(() => {
    Object.assign(coopExit, defaults);
    setCoopSession(null);
  });

  const pressMenu = () => game.scene.uiInputs.buttonMenu();

  /** Start as `role`, choose the local command and wait while the partner has not chosen theirs. */
  async function waitForPartner(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    game.move.select(MoveId.SPLASH, FIELD[role]);
    const waiting = game.phaseInterceptor.to("TurnStartPhase", false);
    await waitForCoop(() => getCoopWaitButtonText() !== null);
    // Leave the interceptor waiting; the run ends or the partner answers.
    waiting.catch(() => {});
    return partner;
  }

  it("shows the button only while waiting", async () => {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    expect(getCoopWaitButtonText()).toBeNull();

    game.move.select(MoveId.SPLASH, FIELD.host);
    partner.onReceive(message => {
      if (message.t === "turnCommand") {
        expect(getCoopWaitButtonText()).toBe(coopText("saveAndQuitButton"));
        partner.sendCommand(synthesizeMoveCommand(FIELD.guest, MoveId.SPLASH));
      }
    });
    await game.toEndOfTurn();

    expect(getCoopWaitButtonText()).toBeNull();
  });

  it("the menu key asks once, then saves and quits for both", async () => {
    const partner = await waitForPartner("host");
    const saveAll = vi.spyOn(game.scene.gameData, "saveAll");

    pressMenu();
    expect(getCoopWaitButtonText()).toBe(coopText("saveAndQuitConfirm"));
    expect(partner.received.some(m => m.t === "bye")).toBe(false);

    pressMenu();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(partner.received).toContainEqual({ t: "bye", reason: "saveAndQuit" } satisfies CoopMessage);
    expect(saveAll).toHaveBeenCalledWith(true, true, true, true);
    expect(getCoopBannerText()).toBe(coopText("savingAndQuitting"));
    expect(coopSession).toBeNull();
  });

  it("the guest tells the host and saves no session", async () => {
    const partner = await waitForPartner("guest");
    const saveAll = vi.spyOn(game.scene.gameData, "saveAll");

    pressMenu();
    pressMenu();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(partner.received).toContainEqual({ t: "bye", reason: "saveAndQuit" } satisfies CoopMessage);
    expect(saveAll).not.toHaveBeenCalled();
  });

  it("the menu key opens the menu as usual when nobody waits", async () => {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    await waitForCoop(() => game.scene.ui.mode === UiMode.COMMAND);

    pressMenu();

    expect(game.scene.ui.mode).toBe(UiMode.MENU);
    expect(partner.received.some(m => m.t === "bye")).toBe(false);
  });

  it("the menu's save and quit tells the partner too", async () => {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    await waitForCoop(() => game.scene.ui.mode === UiMode.COMMAND);
    pressMenu();
    const menu = game.scene.ui.getHandler() as MenuUiHandler;
    const saveAndQuit = menu["config"]?.options.find(o => o.label === i18next.t("menuUiHandler:saveAndQuit"));
    expect(saveAndQuit).toBeDefined();

    saveAndQuit?.handler();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(partner.received).toContainEqual({ t: "bye", reason: "saveAndQuit" } satisfies CoopMessage);
  });

  describe("on the reward screen", () => {
    beforeEach(() => {
      game.override.moveset([MoveId.HYPER_VOICE, MoveId.SPLASH]);
    });

    it("offers the button to the player waiting for the picker", async () => {
      // Wave 1 is the host's to pick on.
      const partner = await toCoopRewardScreen(game, "guest", 1, startInfo());
      expect(getCoopWaitButtonText()).toBe(coopText("saveAndQuitButton"));

      pressMenu();
      pressMenu();
      await waitForCoop(() => returnToTitle.mock.calls.length > 0);
      expect(partner.received).toContainEqual({ t: "bye", reason: "saveAndQuit" } satisfies CoopMessage);
    });

    it("drops the button when the screen closes", async () => {
      const partner = await toCoopRewardScreen(game, "guest", 1, startInfo());
      expect(getCoopWaitButtonText()).not.toBeNull();

      partner.send({
        t: "reward",
        wave: 1,
        gen: getCoopRewardGen(),
        req: 0,
        by: "host",
        seq: 0,
        action: { kind: "skip" },
      });
      await waitForCoop(() => !game.isCurrentPhase("SelectModifierPhase"));
      expect(getCoopWaitButtonText()).toBeNull();
    });

    it("leaves the menu to the picker", async () => {
      await toCoopRewardScreen(game, "host", 1, startInfo());
      expect(getCoopWaitButtonText()).toBeNull();
    });
  });
});
