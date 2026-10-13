import { getSessionDataLocalStorageKey } from "#app/account";
import { getCoopBannerText } from "#coop/coop-banner";
import { coopExit } from "#coop/coop-exit";
import { coopLobby, openCoopLobby } from "#coop/coop-lobby";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { COOP_SESSION_SLOT, coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { createLoopbackPair } from "#coop/loopback-transport";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand, waitForCoop } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
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
  seed: "coop-exit",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

const FIELD = { host: 0, guest: 1 } as const;

describe("co-op connection loss", () => {
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
    Object.assign(coopExit, { returnToTitle, noticeMs: 0, reconnectWindowMs: 200 });
  });

  afterEach(() => {
    Object.assign(coopExit, defaults);
    setCoopSession(null);
  });

  const coopSlotSave = () => localStorage.getItem(getSessionDataLocalStorageKey(COOP_SESSION_SLOT));

  async function startAs(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role, { reliable: true });
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    return partner;
  }

  it("continues when the partner reconnects within the minute", async () => {
    const partner = await startAs("host");
    coopExit.reconnectWindowMs = 10_000;

    partner.drop();
    expect(getCoopBannerText()).toBe(coopText("partnerReconnecting", { seconds: 10 }));
    // Chosen while the connection is down: resent once it is back.
    let receivedWhileDown = -1;
    const realSend = partner.localTransport.send.bind(partner.localTransport);
    vi.spyOn(partner.localTransport, "send").mockImplementation(message => {
      realSend(message);
      if (message.t === "turnCommand") {
        receivedWhileDown = partner.sentCommands.length;
        setTimeout(() => partner.restore(), 20);
      }
    });
    partner.onReceive(message => {
      if (message.t === "turnCommand") {
        partner.sendCommand(synthesizeMoveCommand(FIELD.guest, MoveId.SPLASH));
      }
    });
    game.move.select(MoveId.SPLASH, FIELD.host);
    await game.toEndOfTurn();

    expect(receivedWhileDown).toBe(0);
    expect(partner.sentCommands).toHaveLength(1);
    expect(getCoopBannerText()).toBeNull();
    expect(returnToTitle).not.toHaveBeenCalled();
    expect(coopSession).not.toBeNull();
  });

  it("the host saves the wave start and returns to the title when the partner does not come back", async () => {
    const partner = await startAs("host");
    const wave = game.scene.currentBattle.waveIndex;
    const saveAll = vi.spyOn(game.scene.gameData, "saveAll");

    partner.drop();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(saveAll).toHaveBeenCalledWith(true, true, true, true);
    const saved = await game.scene.gameData.getSession(COOP_SESSION_SLOT);
    expect(saved?.waveIndex).toBe(wave);
    expect(saved?.coop).toBeDefined();
    expect(coopSession).toBeNull();
  });

  it("stops the running game before returning to the title", async () => {
    const partner = await startAs("guest");
    // Animations and queued phases still running when the run ends.
    const killAll = vi.spyOn(game.scene.tweens, "killAll");
    game.scene.phaseManager.pushNew("MessagePhase", "still queued");
    let stopped = false;
    returnToTitle.mockImplementation(() => {
      stopped = !game.scene.phaseManager.hasPhaseOfType("MessagePhase") && killAll.mock.calls.length > 0;
    });

    partner.drop();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(stopped).toBe(true);
  });

  it("the guest saves no session when the host does not come back", async () => {
    const partner = await startAs("guest");

    partner.drop();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(coopSlotSave()).toBeFalsy();
    expect(coopSession).toBeNull();
  });

  it.each<[string, CoopMessage, string]>([
    ["saved and quit", { t: "bye", reason: "saveAndQuit" }, "partnerSavedAndQuit"],
    ["left", { t: "bye" }, "partnerLeftRun"],
  ])("ends the run when the partner %s", async (_, bye, text) => {
    const partner = await startAs("host");
    const saveAll = vi.spyOn(game.scene.gameData, "saveAll");

    partner.send(bye);
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(saveAll).toHaveBeenCalledWith(true, true, true, true);
    expect(getCoopBannerText()).toBe(coopText(text as "partnerLeftRun"));
    expect(coopSession).toBeNull();
  });

  it("ends the run when the connection closes", async () => {
    const partner = await startAs("guest");
    partner.close();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);
    expect(coopSession).toBeNull();
  });

  it("leaves the starter selection when the partner does not come back", async () => {
    await game.runToTitle();
    const pair = createLoopbackPair();
    await pair.host.host();
    await pair.guest.join("LOOP00");
    openCoopLobby(
      { role: "guest", transport: pair.guest, peerAccountName: "Hosty", peerTrainerId: 0, peerResume: false },
      { getAccount: () => snapshot(2) },
    );

    pair.drop();
    expect(getCoopBannerText()).toBe(coopText("partnerReconnecting", { seconds: 1 }));
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(coopLobby).toBeNull();
  });
});
