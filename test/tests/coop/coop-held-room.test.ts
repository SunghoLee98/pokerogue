import { getCoopBannerText } from "#coop/coop-banner";
import { getLocalCoopInfo } from "#coop/coop-connect";
import { coopExit, type HeldCoopRoom, takeHeldCoopRoom } from "#coop/coop-exit";
import { performHandshake } from "#coop/coop-handshake";
import { leaveCoop } from "#coop/coop-lobby";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { waitForCoopResume, waitForReturningPartner } from "#coop/coop-resume";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { createLoopbackPair, LoopbackTransport } from "#coop/loopback-transport";
import { ReliableCoopTransport } from "#coop/reliable-coop-transport";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import type { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, waitForCoop } from "#test/utils/coop-partner";
import { createFreshGameManager, createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const HOST_TRAINER = 101;
const GUEST_TRAINER = 202;
const CODE = "ABC123";
const participants = { host: "Hosty", guest: "Guesty" };

const startInfo = (): CoopStartInfo => ({
  seed: "coop-held-room",
  accounts: { host: snapshot(HOST_TRAINER), guest: snapshot(GUEST_TRAINER) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

/** What a player tells the partner in the handshake. */
const infoOf = (role: CoopRole, accountName = participants[role]) => ({
  ...getLocalCoopInfo(),
  accountName,
  trainerId: role === "host" ? HOST_TRAINER : GUEST_TRAINER,
});

/** The next message a connection receives. */
function nextMessage(transport: LoopbackTransport): Promise<CoopMessage> {
  return new Promise(resolve => {
    const unsubscribe = transport.onMessage(message => {
      unsubscribe();
      resolve(message);
    });
  });
}

describe("co-op room kept for a partner who comes back", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;
  let returnToTitle: ReturnType<typeof vi.fn>;
  const defaults = { ...coopExit };

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = createFreshGameManager(phaserGame);
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingLevel(100)
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH]);
    // Saves are real here: both clients keep the save made at the start of the wave.
    vi.mocked(game.scene.gameData.saveAll).mockRestore();
    returnToTitle = vi.fn();
    Object.assign(coopExit, { returnToTitle, noticeMs: 0, reconnectWindowMs: 200 });
  });

  afterEach(() => {
    Object.assign(coopExit, defaults);
    takeHeldCoopRoom()?.transport.close();
    leaveCoop();
    setCoopSession(null);
  });

  /** Start a run whose connection is a relay room with a join code; returns the local end of it. */
  async function startAs(role: CoopRole): Promise<{ partner: CoopTestPartner; room: LoopbackTransport }> {
    const partner = new CoopTestPartner(role, { reliable: true });
    const room = partner["pair"][role];
    room.joinCode = CODE;
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport, participants });
    return { partner, room };
  }

  it.each<CoopRole>(["host", "guest"])("the %s keeps the room when the partner does not come back", async role => {
    const { partner, room } = await startAs(role);
    const wave = game.scene.currentBattle.waveIndex;

    partner.drop();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(getCoopBannerText()).toBe(coopText("partnerGone"));
    const held = takeHeldCoopRoom();
    expect(held).toMatchObject({ code: CODE, role, transport: room });
    const save = JSON.parse(held!.save!);
    expect(save.waveIndex).toBe(wave);
    expect(save.coop.participants).toEqual(participants);
    // Leaving the run did not close the room or say goodbye in it.
    expect(room.status).not.toBe("closed");
    expect(coopSession).toBeNull();
  });

  it("keeps the room as soon as a new client takes the partner's place", async () => {
    const { room } = await startAs("host");

    room.acceptNewPeer(new LoopbackTransport());
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(getCoopBannerText()).toBe(coopText("partnerReturned"));
    expect(takeHeldCoopRoom()?.transport.status).toBe("newPeer");
  });

  it("tells a player whose own connection closed the code to join again with", async () => {
    const { partner } = await startAs("guest");
    partner.close();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(getCoopBannerText()).toBe(coopText("disconnected", { code: CODE }));
    expect(takeHeldCoopRoom()).toBeNull();
  });

  it("shows the code again on the title screen and continues the run with the partner who comes back", async () => {
    const { partner, room } = await startAs("host");
    const wave = game.scene.currentBattle.waveIndex;
    partner.drop();
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    // Back on the title screen, which waits in the room instead of showing its options.
    game = createFreshGameManager(phaserGame);
    game.override.battleStyle(null).disableTrainerWaves().enemyMoveset(MoveId.SPLASH);
    const showText = vi.spyOn(game.scene.ui, "showText");
    await game.runToTitle();
    expect(showText.mock.calls.some(([text]) => text === coopText("waitingForPartnerReturn", { code: CODE }))).toBe(
      true,
    );

    // The guest reloaded the page and joins with the code.
    const returning = new LoopbackTransport();
    room.acceptNewPeer(returning);
    const partnerInfo = await performHandshake(returning, infoOf("guest"));
    expect(partnerInfo.peerResume).toBe(true);
    const resumed = await waitForCoopResume(new ReliableCoopTransport(returning));
    expect(resumed.role).toBe("guest");
    await game.phaseInterceptor.to("EncounterPhase", false);

    expect(JSON.parse(resumed.session).waveIndex).toBe(wave);
    expect(coopSession?.localRole).toBe("host");
    expect(game.scene.currentBattle.waveIndex).toBe(wave);
    expect(game.scene.phaseManager.getCurrentPhase()["loaded"]).toBe(true);
  });

  describe("waiting in the room", () => {
    const save = JSON.stringify({
      waveIndex: 7,
      coop: { participants, accounts: { host: snapshot(HOST_TRAINER), guest: snapshot(GUEST_TRAINER) } },
    });

    /** A room this player stayed in after the partner dropped, and the connection to it. */
    async function heldRoom(
      role: CoopRole,
      held: string | null = save,
    ): Promise<{ room: HeldCoopRoom; loopback: LoopbackTransport }> {
      const pair = createLoopbackPair();
      pair.host.joinCode = CODE;
      await pair.host.host();
      await pair.guest.join("LOOP00");
      pair.host.losePeer();
      return { room: { transport: pair.host, code: CODE, role, save: held }, loopback: pair.host };
    }

    it.each<CoopRole>(["host", "guest"])(
      "the %s who stayed sends the run to the partner who comes back",
      async role => {
        const { room, loopback } = await heldRoom(role);
        const partnerRole = role === "host" ? "guest" : "host";
        const waiting = waitForReturningPartner(room, infoOf(role));

        const returning = new LoopbackTransport();
        loopback.acceptNewPeer(returning);
        expect((await performHandshake(returning, infoOf(partnerRole))).peerResume).toBe(true);
        await expect(waitForCoopResume(new ReliableCoopTransport(returning))).resolves.toEqual({
          session: save,
          role: partnerRole,
        });
        const connection = await waiting;
        expect(connection.role).toBe(role);
        expect(connection.peerAccountName).toBe(participants[partnerRole]);
      },
    );

    it("sends away another account and keeps waiting", async () => {
      const { room, loopback } = await heldRoom("host");
      const waiting = waitForReturningPartner(room, infoOf("host"));

      const stranger = new LoopbackTransport();
      loopback.acceptNewPeer(stranger);
      await performHandshake(stranger, infoOf("guest", "Someone"));
      expect(await nextMessage(stranger)).toMatchObject({ t: "bye", reason: "wrongAccount" });

      loopback.losePeer();
      const returning = new LoopbackTransport();
      loopback.acceptNewPeer(returning);
      await performHandshake(returning, infoOf("guest"));
      await expect(waitForCoopResume(new ReliableCoopTransport(returning))).resolves.toMatchObject({ role: "guest" });
      expect((await waiting).peerAccountName).toBe("Guesty");
    });

    it("lets a partner come back to the lobby", async () => {
      const { room, loopback } = await heldRoom("host", null);
      const waiting = waitForReturningPartner(room, infoOf("host"));

      const returning = new LoopbackTransport();
      loopback.acceptNewPeer(returning);
      expect((await performHandshake(returning, infoOf("guest"))).peerResume).toBe(false);
      expect((await waiting).role).toBe("host");
    });

    it("stops waiting when the connection closes", async () => {
      const { room, loopback } = await heldRoom("host");
      const waiting = waitForReturningPartner(room, infoOf("host"));
      loopback.close();
      await expect(waiting).rejects.toThrow();
    });
  });
});
