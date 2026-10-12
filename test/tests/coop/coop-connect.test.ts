import { CoopJoinInputError, hostCoop, isCoopAvailable, joinCoop } from "#coop/coop-connect";
import { createCoopGameMode } from "#coop/coop-game-start";
import { CoopVersionMismatchError } from "#coop/coop-handshake";
import { coopLobby, leaveCoop, openCoopLobby, startCoopRunFromLobby } from "#coop/coop-lobby";
import { CoopSession, coopSession, setCoopSession } from "#coop/coop-session";
import { CoopStarterSelection } from "#coop/coop-starter-selection";
import type { CoopConnectionStatus, CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { SelectStarterPhase } from "#phases/select-starter-phase";
import { GameManager } from "#test/framework/game-manager";
import { createTestStarterPayload } from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const emptySnapshot = { trainerId: 0, secretId: 0, caughtSpecies: [], eggMoves: {}, unlocks: [] };

function statusesOf(transport: CoopTransport): CoopConnectionStatus[] {
  const statuses: CoopConnectionStatus[] = [];
  transport.onStatusChange(status => statuses.push(status));
  return statuses;
}

describe("co-op connection", () => {
  afterEach(() => {
    leaveCoop();
  });

  it("connects host and guest through the handshake", async () => {
    const pair = createLoopbackPair();
    const codes: string[] = [];
    const urls: string[] = [];

    const [host, guest] = await Promise.all([
      hostCoop(pair.host, code => codes.push(code), { gameVersion: "1.0.0", accountName: "Hosty" }),
      flush().then(() =>
        joinCoop(" loop-00 ", {
          local: { gameVersion: "1.0.0", accountName: "Guesty" },
          defaultRelayUrl: "wss://relay.test",
          createTransport: url => {
            urls.push(url);
            return pair.guest;
          },
        }),
      ),
    ]);

    expect(codes).toEqual(["LOOP00"]);
    expect(urls).toEqual(["wss://relay.test"]);
    expect(host).toEqual({ role: "host", transport: pair.host, peerAccountName: "Guesty" });
    expect(guest).toEqual({ role: "guest", transport: pair.guest, peerAccountName: "Hosty" });
  });

  it("rejects a malformed join code without connecting", async () => {
    const createTransport = vi.fn();
    await expect(joinCoop("ab", { defaultRelayUrl: "wss://relay.test", createTransport })).rejects.toBeInstanceOf(
      CoopJoinInputError,
    );
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("needs a relay for a bare code", async () => {
    const createTransport = vi.fn();
    await expect(joinCoop("abc123", { defaultRelayUrl: undefined, createTransport })).rejects.toBeInstanceOf(
      CoopJoinInputError,
    );
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("uses the address in the join input as the relay", async () => {
    const pair = createLoopbackPair();
    const urls: string[] = [];
    const join = vi.spyOn(pair.guest, "join");

    await expect(
      joinCoop("192.168.0.10:8787/abc123", {
        defaultRelayUrl: "wss://relay.test",
        createTransport: url => {
          urls.push(url);
          return pair.guest;
        },
      }),
    ).rejects.toThrow("unknown join code");

    expect(urls).toEqual(["ws://192.168.0.10:8787"]);
    expect(join).toHaveBeenCalledWith("ABC123");
  });

  it("rejects a version mismatch", async () => {
    const pair = createLoopbackPair();
    const host = hostCoop(pair.host, () => {}, { gameVersion: "1.0.0", accountName: "Hosty" });
    await flush();
    const guest = joinCoop("LOOP00", {
      local: { gameVersion: "2.0.0", accountName: "Guesty" },
      createTransport: () => pair.guest,
      defaultRelayUrl: "wss://relay.test",
    });

    await expect(host).rejects.toBeInstanceOf(CoopVersionMismatchError);
    await expect(guest).rejects.toBeInstanceOf(CoopVersionMismatchError);
  });

  it("co-op needs a relay url", () => {
    expect(isCoopAvailable(undefined)).toBe(false);
    expect(isCoopAvailable("")).toBe(false);
    expect(isCoopAvailable("wss://relay.test")).toBe(true);
  });

  it("opens a lobby with a starter selection", () => {
    const pair = createLoopbackPair();
    const lobby = openCoopLobby(
      { role: "guest", transport: pair.guest, peerAccountName: "Hosty" },
      { getAccount: () => emptySnapshot },
    );

    expect(coopLobby).toBe(lobby);
    expect(lobby.role).toBe("guest");
    expect(lobby.peerAccountName).toBe("Hosty");
    expect(lobby.selection.role).toBe("guest");
  });

  it("leaving closes the lobby", async () => {
    const pair = createLoopbackPair();
    await pair.host.host();
    await pair.guest.join("LOOP00");
    const peerStatuses = statusesOf(pair.host);
    const peerMessages: string[] = [];
    pair.host.onMessage(message => peerMessages.push(message.t));
    openCoopLobby(
      { role: "guest", transport: pair.guest, peerAccountName: "Hosty" },
      { getAccount: () => emptySnapshot },
    );

    leaveCoop();
    await flush();

    expect(coopLobby).toBeNull();
    expect(peerMessages).toEqual(["bye"]);
    expect(peerStatuses).toEqual(["closed"]);
  });

  it("leaving ends a running session", async () => {
    const pair = createLoopbackPair();
    await pair.host.host();
    await pair.guest.join("LOOP00");
    const peerStatuses = statusesOf(pair.guest);
    setCoopSession(new CoopSession("host", pair.host));

    leaveCoop();
    await flush();

    expect(coopSession).toBeNull();
    expect(peerStatuses).toEqual(["closed"]);
  });

  it("does nothing outside co-op", () => {
    expect(() => leaveCoop()).not.toThrow();
    expect(coopLobby).toBeNull();
    expect(coopSession).toBeNull();
  });
});

describe("co-op run from the lobby", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    leaveCoop();
  });

  it("starts the agreed run and hands the lobby over to the session", async () => {
    const game = new GameManager(phaserGame);
    game.override.battleStyle("double").disableTrainerWaves();
    const pair = createLoopbackPair();
    await pair.host.host();
    await pair.guest.join("LOOP00");
    const lobby = openCoopLobby(
      { role: "host", transport: pair.host, peerAccountName: "Guesty" },
      { getAccount: () => emptySnapshot },
    );
    const guest = new CoopStarterSelection("guest", pair.guest, { getAccount: () => emptySnapshot });
    lobby.selection.setReady([createTestStarterPayload(SpeciesId.BULBASAUR)]);
    guest.setReady([createTestStarterPayload(SpeciesId.CHARMANDER)]);
    await flush();
    expect(lobby.selection.startInfo).not.toBeNull();

    await game.runToTitle();
    game.onNextPrompt("TitlePhase", UiMode.TITLE, async () => {
      game.scene.gameMode = createCoopGameMode();
      game.scene.phaseManager.pushNew("EncounterPhase", false);
      const phase = new SelectStarterPhase();
      await startCoopRunFromLobby(() => phase.initBattle([]));
    });
    await game.phaseInterceptor.to("EncounterPhase");

    expect(coopLobby).toBeNull();
    expect(coopSession?.localRole).toBe("host");
    expect(coopSession?.transport).toBe(pair.host);
    expect(game.scene.getPlayerParty().map(p => p.species.speciesId)).toEqual([
      SpeciesId.BULBASAUR,
      SpeciesId.CHARMANDER,
    ]);
    guest.dispose();
  });
});
