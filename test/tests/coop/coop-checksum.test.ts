import { coopExit } from "#coop/coop-exit";
import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { LoopbackTransport } from "#coop/loopback-transport";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand, waitForCoop } from "#test/utils/coop-partner";
import {
  type CoopTestAccount,
  createFreshGameManager,
  createTestStarterPayload,
  runCoopReplay,
  startCoopBattle,
} from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ChecksumMessage = Extract<CoopMessage, { t: "checksum" }>;

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-checksum",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

const checksums = (messages: CoopMessage[]) => messages.filter((m): m is ChecksumMessage => m.t === "checksum");

describe("co-op checksum exchange", () => {
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
    vi.mocked(game.scene.gameData.saveAll).mockRestore();
    returnToTitle = vi.fn();
    Object.assign(coopExit, { returnToTitle, noticeMs: 0 });
  });

  afterEach(() => {
    Object.assign(coopExit, defaults);
    setCoopSession(null);
  });

  async function playTurn(partner: CoopTestPartner): Promise<void> {
    game.move.select(MoveId.SPLASH, 0);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SPLASH));
    await game.toEndOfTurn();
  }

  it("sends the state hash at the start of the wave and the end of each turn", async () => {
    const partner = new CoopTestPartner("host");
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    expect(checksums(partner.received)).toEqual([{ t: "checksum", wave: 1, turn: 1, hash: expect.any(String) }]);

    await playTurn(partner);

    expect(checksums(partner.received).map(({ wave, turn }) => [wave, turn])).toEqual([
      [1, 1],
      [1, 2],
    ]);
  });

  it("keeps playing while the partner's hashes match", async () => {
    const partner = new CoopTestPartner("host");
    partner.onReceive(message => {
      if (message.t === "checksum") {
        partner.send(message);
      }
    });
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    await playTurn(partner);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(returnToTitle).not.toHaveBeenCalled();
    expect(coopSession).not.toBeNull();
  });

  it("saves and stops when a hash differs", async () => {
    const error = vi.spyOn(console, "error");
    const partner = new CoopTestPartner("host");
    partner.onReceive(message => {
      if (message.t === "checksum") {
        partner.send({ ...message, hash: "0000000000000000" });
      }
    });
    const saveAll = vi.spyOn(game.scene.gameData, "saveAll");
    await startCoopBattle(game, { role: "host", start: startInfo(), transport: partner.localTransport });
    await waitForCoop(() => returnToTitle.mock.calls.length > 0);

    expect(error.mock.calls.some(([text]) => String(text).includes("desync"))).toBe(true);
    expect(partner.received).toContainEqual({ t: "bye", reason: "desync" } satisfies CoopMessage);
    expect(saveAll).toHaveBeenCalledWith(true, true, true, true);
    expect(coopSession).toBeNull();
  });
});

describe("co-op checksums of both clients", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const account = (trainerId: number): CoopTestAccount => ({
    trainerId,
    secretId: 3,
    unlocks: [],
    caughtSpecies: [],
    eggMoves: {},
  });

  /** The checksum messages a run sends. */
  function recordChecksums(): ChecksumMessage[] {
    const sent: ChecksumMessage[] = [];
    const send = LoopbackTransport.prototype.send;
    vi.spyOn(LoopbackTransport.prototype, "send").mockImplementation(function (this: LoopbackTransport, message) {
      if (message.t === "checksum") {
        sent.push(message);
      }
      send.call(this, message);
    });
    return sent;
  }

  it("host and guest send the same hashes", async () => {
    const options = (role: CoopRole) => ({
      role,
      accounts: { host: account(4321), guest: account(8765) },
      localCommand: () => ({ kind: "move" as const, moveId: MoveId.SPLASH }),
      species: [SpeciesId.BULBASAUR, SpeciesId.CHARMANDER] as [SpeciesId, SpeciesId],
      waves: 1,
      turns: 2,
    });
    const freshGame = () => {
      const fresh = createFreshGameManager(phaserGame);
      fresh.override.moveset([MoveId.SPLASH]);
      return fresh;
    };
    // A fresh game restores all mocks, so the recording starts after it.
    const hostGame = freshGame();
    const hostSent = recordChecksums();
    const log = await runCoopReplay(hostGame, {
      ...options("host"),
      remote: { command: () => ({ kind: "move", moveId: MoveId.SPLASH }) },
    });
    const guestGame = freshGame();
    const guestSent = recordChecksums();
    await runCoopReplay(guestGame, { ...options("guest"), remote: { log } });

    expect(hostSent.length).toBeGreaterThanOrEqual(3);
    expect(guestSent).toEqual(hostSent);
  });
});
