import { getLocalCoopInfo, hostCoop, joinCoop } from "#coop/coop-connect";
import { leaveCoop } from "#coop/coop-lobby";
import type { CoopAccountSnapshot, CoopMessage } from "#coop/coop-protocol";
import { CoopWrongAccountError, waitForCoopResume } from "#coop/coop-resume";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { coopTransportFactory } from "#coop/coop-title-menu";
import { createLoopbackPair } from "#coop/loopback-transport";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, waitForCoop } from "#test/utils/coop-partner";
import { createFreshGameManager, createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { SessionSaveData } from "#types/save-data";
import type { ModalConfig, OptionSelectItem } from "#types/ui-types";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const HOST_TRAINER = 101;
const GUEST_TRAINER = 202;

const startInfo = (): CoopStartInfo => ({
  seed: "coop-resume-menu",
  accounts: { host: snapshot(HOST_TRAINER), guest: snapshot(GUEST_TRAINER) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

describe("continuing a co-op run from the title screen", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let saved: SessionSaveData;

  beforeAll(async () => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
    // A run saved at the start of wave 1, by a host "Hosty" playing with "Guesty".
    const recorder = createFreshGameManager(phaserGame);
    recorder.override.battleStyle(null).disableTrainerWaves().enemyMoveset(MoveId.SPLASH);
    const partner = new CoopTestPartner("host");
    await startCoopBattle(recorder, {
      role: "host",
      start: startInfo(),
      transport: partner.localTransport,
      participants: { host: "Hosty", guest: "Guesty" },
    });
    saved = JSON.parse(JSON.stringify(recorder.reload["sessionData"]));
    setCoopSession(null);
  });

  beforeEach(async () => {
    vi.stubEnv("VITE_COOP_RELAY_URL", "wss://relay.test");
    game = createFreshGameManager(phaserGame);
    game.override.battleStyle(null).disableTrainerWaves().enemyMoveset(MoveId.SPLASH);
    await game.scene.ui.setMode(UiMode.MESSAGE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    leaveCoop();
  });

  function labels(): string[] {
    return (game.scene.ui.getHandler() as OptionSelectUiHandler)["options"].map(o => o.label);
  }

  function choose(label: string): void {
    const option = (game.scene.ui.getHandler() as OptionSelectUiHandler)["options"].find(
      (o: OptionSelectItem) => o.label === label,
    );
    expect(option, `option "${label}"`).toBeDefined();
    option?.handler?.();
  }

  /** The host's save in the co-op slot, as the save slot reads it. */
  function withCoopSave(): void {
    vi.spyOn(game.scene.gameData, "getSession").mockImplementation(async slot =>
      slot === 5 ? game.scene.gameData.parseSessionData(JSON.stringify(saved)) : undefined,
    );
  }

  async function openCoopMenu(): Promise<void> {
    await game.runToTitle();
    choose(coopText("coopPlay"));
    await waitForCoop(() => game.scene.ui.mode === UiMode.OPTION_SELECT && labels().includes(coopText("joinGame")));
  }

  const guestInfo = (trainerId = GUEST_TRAINER, accountName = "Guesty") => ({
    ...getLocalCoopInfo(),
    accountName,
    trainerId,
  });

  it("offers to continue only with a co-op save", async () => {
    await openCoopMenu();
    expect(labels()).not.toContain(coopText("continueGame"));
  });

  it("continues with the saved partner", async () => {
    withCoopSave();
    const pair = createLoopbackPair();
    vi.spyOn(coopTransportFactory, "createTransport").mockReturnValue(pair.host);
    await openCoopMenu();
    expect(labels()).toContain(coopText("continueGame"));

    choose(coopText("continueGame"));
    await flush();
    const guest = await joinCoop("LOOP00", { createTransport: () => pair.guest, local: guestInfo() });
    expect(guest.peerResume).toBe(true);
    const { session: json, role } = await waitForCoopResume(guest.transport);
    await game.phaseInterceptor.to("EncounterPhase", false);

    expect(JSON.parse(json).coop).toEqual(saved.coop);
    expect(role).toBe("guest");
    expect(coopSession?.localRole).toBe("host");
    expect(game.scene.currentBattle.waveIndex).toBe(saved.waveIndex);
    expect(game.scene.phaseManager.getCurrentPhase()["loaded"]).toBe(true);
  });

  it.each([
    ["another trainer id", GUEST_TRAINER + 1, "Guesty"],
    ["another account name", GUEST_TRAINER, "Someone"],
  ])("turns away %s", async (_, trainerId, accountName) => {
    withCoopSave();
    const pair = createLoopbackPair();
    vi.spyOn(coopTransportFactory, "createTransport").mockReturnValue(pair.host);
    const showText = vi.spyOn(game.scene.ui, "showText");
    await openCoopMenu();

    choose(coopText("continueGame"));
    await flush();
    const guest = await joinCoop("LOOP00", {
      createTransport: () => pair.guest,
      local: guestInfo(trainerId, accountName),
    });

    await expect(waitForCoopResume(guest.transport)).rejects.toBeInstanceOf(CoopWrongAccountError);
    await flush();
    expect(showText.mock.calls.some(([text]) => text === coopText("wrongPartnerJoined"))).toBe(true);
    expect(coopSession).toBeNull();
  });

  it("the guest continues the host's run", async () => {
    const pair = createLoopbackPair();
    vi.spyOn(coopTransportFactory, "createTransport").mockReturnValue(pair.guest);
    const { ui } = game.scene;
    const showOverlay = ui.setOverlayMode.bind(ui);
    const setOverlayMode = vi
      .spyOn(ui, "setOverlayMode")
      .mockImplementation((mode, ...args) =>
        mode === UiMode.COOP_JOIN_FORM ? Promise.resolve() : showOverlay(mode, ...args),
      );
    await openCoopMenu();
    choose(coopText("joinGame"));
    const form = setOverlayMode.mock.calls.find(([mode]) => mode === UiMode.COOP_JOIN_FORM)?.[1] as ModalConfig;

    // The host's client: continue the saved run with this guest.
    const hosting = hostCoop(pair.host, () => {}, { ...getLocalCoopInfo(), accountName: "Hosty", resume: true });
    form.buttonActions[0]("LOOP00");
    const host = await hosting;
    host.transport.send({ t: "resume", session: JSON.stringify(saved) } satisfies CoopMessage);
    await game.phaseInterceptor.to("EncounterPhase", false);

    expect(coopSession?.localRole).toBe("guest");
    expect(coopSession?.ownership.toJSON()).toEqual(saved.coop?.ownership);
    expect(game.scene.currentBattle.waveIndex).toBe(saved.waveIndex);
  });

  it("the guest is told when it is not the saved partner", async () => {
    const pair = createLoopbackPair();
    vi.spyOn(coopTransportFactory, "createTransport").mockReturnValue(pair.guest);
    const showText = vi.spyOn(game.scene.ui, "showText");
    const { ui } = game.scene;
    const showOverlay = ui.setOverlayMode.bind(ui);
    const setOverlayMode = vi
      .spyOn(ui, "setOverlayMode")
      .mockImplementation((mode, ...args) =>
        mode === UiMode.COOP_JOIN_FORM ? Promise.resolve() : showOverlay(mode, ...args),
      );
    await openCoopMenu();
    choose(coopText("joinGame"));
    const form = setOverlayMode.mock.calls.find(([mode]) => mode === UiMode.COOP_JOIN_FORM)?.[1] as ModalConfig;

    const hosting = hostCoop(pair.host, () => {}, { ...getLocalCoopInfo(), accountName: "Hosty", resume: true });
    form.buttonActions[0]("LOOP00");
    const host = await hosting;
    host.transport.send({ t: "bye", reason: "wrongAccount" });
    await waitForCoop(() => showText.mock.calls.some(([text]) => text === coopText("notTheSavedPartner")));

    expect(coopSession).toBeNull();
  });
});
