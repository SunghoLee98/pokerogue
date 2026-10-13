import { loggedInUser, updateUserInfo } from "#app/account";
import { getLocalCoopInfo, joinCoop } from "#coop/coop-connect";
import { CoopVersionMismatchError } from "#coop/coop-handshake";
import { coopLobby, leaveCoop } from "#coop/coop-lobby";
import { coopSaveServer } from "#coop/coop-save";
import { coopText } from "#coop/coop-text";
import { coopTransportFactory, describeCoopError } from "#coop/coop-title-menu";
import { createLoopbackPair } from "#coop/loopback-transport";
import { CoopRelayError } from "#coop/relay-websocket-transport";
import { ReliableCoopTransport } from "#coop/reliable-coop-transport";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { waitForCoop } from "#test/utils/coop-partner";
import type { ModalConfig, OptionSelectItem } from "#types/ui-types";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import i18next from "i18next";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("co-op text", () => {
  it("falls back to built-in text when a key is missing", () => {
    expect(coopText("coopPlay")).toBe("Co-op Play");
    expect(coopText("waitingForPartner", { code: "ABC123" })).toContain("ABC123");
  });

  it("uses Korean text for Korean", () => {
    vi.spyOn(i18next, "language", "get").mockReturnValue("ko");
    expect(coopText("coopPlay")).toBe("협동 플레이");
    vi.restoreAllMocks();
  });

  it("explains connection errors", () => {
    expect(describeCoopError(new CoopRelayError("notFound"))).toBe(coopText("codeNotFound"));
    expect(describeCoopError(new CoopRelayError("full"))).toBe(coopText("roomFull"));
    expect(describeCoopError(new CoopVersionMismatchError("1.0", "2.0"))).toBe(
      coopText("versionMismatch", { local: "1.0", peer: "2.0" }),
    );
    expect(describeCoopError(new Error("boom"))).toBe(coopText("connectionFailed"));
  });
});

describe("co-op title menu", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async context => {
    // The title screen may build its options as soon as the game is created, so the relay is configured first.
    vi.stubEnv("VITE_COOP_RELAY_URL", context.task.name.startsWith("hides") ? "" : "wss://relay.test");
    game = new GameManager(phaserGame);
    // The UI outlives a game manager; setting the title mode again while still in it would keep the old options.
    await game.scene.ui.setMode(UiMode.MESSAGE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    leaveCoop();
  });

  function currentOptions(): OptionSelectItem[] {
    return (game.scene.ui.getHandler() as OptionSelectUiHandler)["options"];
  }

  /** The co-op menu opens once the co-op save slot has been read. */
  async function coopMenuShown(): Promise<void> {
    await waitForCoop(() => currentOptions().some(o => o.label === coopText("joinGame")));
  }

  function choose(label: string): void {
    const option = currentOptions().find(o => o.label === label);
    expect(option, `option "${label}"`).toBeDefined();
    option?.handler?.();
  }

  it("hides co-op without a relay url", async () => {
    await game.runToTitle();
    expect(game.scene.ui.mode).toBe(UiMode.TITLE);
    expect(currentOptions().map(o => o.label)).not.toContain(coopText("coopPlay"));
  });

  it("a save server without the co-op slot hides co-op", async () => {
    vi.spyOn(coopSaveServer, "supportsCoop").mockResolvedValue(false);
    await game.runToTitle();
    expect(currentOptions().map(o => o.label)).not.toContain(coopText("coopPlay"));
  });

  it("never continues the co-op slot as a solo run", async () => {
    await updateUserInfo();
    loggedInUser!.lastSessionSlot = 5;
    const getSession = vi.spyOn(game.scene.gameData, "getSession");
    await game.runToTitle();
    expect(getSession).not.toHaveBeenCalledWith(5);
    expect(currentOptions().map(o => o.label)).not.toContain(i18next.t("menu:continue"));
  });

  it("shows co-op after new game with a relay url", async () => {
    await game.runToTitle();
    const labels = currentOptions().map(o => o.label);
    expect(labels.indexOf(coopText("coopPlay"))).toBe(labels.indexOf(i18next.t("menu:newGame")) + 1);
  });

  it("hosting shows the join code and starts co-op starter select", async () => {
    const pair = createLoopbackPair();
    const createTransport = vi.spyOn(coopTransportFactory, "createTransport").mockReturnValue(pair.host);
    const showText = vi.spyOn(game.scene.ui, "showText");
    await game.runToTitle();

    choose(coopText("coopPlay"));
    await coopMenuShown();
    choose(coopText("hostGame"));
    await flush();

    expect(createTransport).toHaveBeenCalledWith("wss://relay.test");
    expect(showText.mock.calls.some(([text]) => text.includes("LOOP00"))).toBe(true);

    await joinCoop("LOOP00", { createTransport: () => pair.guest, local: getLocalCoopInfo() });
    await game.phaseInterceptor.to("SelectStarterPhase", false);

    expect(coopLobby?.role).toBe("host");
    expect(coopLobby?.transport).toBeInstanceOf(ReliableCoopTransport);
    expect(game.scene.gameMode.isCoop).toBe(true);
  });

  it("join shows an error for a malformed code", async () => {
    const createTransport = vi.spyOn(coopTransportFactory, "createTransport");
    // Headless text inputs cannot take focus, so record the form instead of showing it.
    const { ui } = game.scene;
    const showOverlay = ui.setOverlayMode.bind(ui);
    const setOverlayMode = vi
      .spyOn(ui, "setOverlayMode")
      .mockImplementation((mode, ...args) =>
        mode === UiMode.COOP_JOIN_FORM ? Promise.resolve() : showOverlay(mode, ...args),
      );
    const showText = vi.spyOn(game.scene.ui, "showText");
    await game.runToTitle();

    choose(coopText("coopPlay"));
    await coopMenuShown();
    choose(coopText("joinGame"));
    const formCall = setOverlayMode.mock.calls.find(([mode]) => mode === UiMode.COOP_JOIN_FORM);
    expect(formCall).toBeDefined();
    const config = formCall?.[1] as ModalConfig;
    config.buttonActions[0]("x");
    await flush();

    expect(showText.mock.calls.some(([text]) => text === coopText("invalidCode"))).toBe(true);
    expect(createTransport).not.toHaveBeenCalled();
    expect(coopLobby).toBeNull();
  });

  it("returning to the title leaves co-op", async () => {
    const pair = createLoopbackPair();
    vi.spyOn(coopTransportFactory, "createTransport").mockReturnValue(pair.host);
    await game.runToTitle();
    choose(coopText("coopPlay"));
    await coopMenuShown();
    choose(coopText("hostGame"));
    await flush();
    await joinCoop("LOOP00", { createTransport: () => pair.guest, local: getLocalCoopInfo() });
    await flush();
    expect(coopLobby).not.toBeNull();

    game.scene.phaseManager.toTitleScreen();
    game.scene.phaseManager.getCurrentPhase().end();
    await game.phaseInterceptor.to("TitlePhase");

    expect(coopLobby).toBeNull();
  });
});
