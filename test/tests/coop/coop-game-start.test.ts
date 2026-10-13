import { timedEventManager } from "#app/global-event-manager";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { speciesEggMoves } from "#balance/moves/egg-moves";
import { assembleCoopParty, beginCoopSession, createCoopGameMode } from "#coop/coop-game-start";
import type { CoopAccountSnapshot, CoopRole, CoopStarterPayload } from "#coop/coop-protocol";
import { COOP_SESSION_SLOT, coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { computeCoopStateHash } from "#coop/coop-state-hash";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { EventType } from "#enums/event-type";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Unlockables } from "#enums/unlockables";
import { GameManager } from "#test/framework/game-manager";
import { answerWaveStartSwitches } from "#test/utils/coop-partner";
import {
  applyTestAccount,
  type CoopTestAccount,
  createFreshGameManager,
  createTestStarterPayload,
  selectCoopStart,
  snapshotForTestAccount,
  startCoopBattle,
} from "#test/utils/coop-replay";
import type { TimedEvent } from "#types/game-events";
import { randSeedInt } from "#utils/common";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

function startInfo(host: SpeciesId[], guest: SpeciesId[], timedEvent: string | null = null): CoopStartInfo {
  return {
    seed: "coop-start-test",
    accounts: { host: snapshot(1), guest: snapshot(2) },
    picks: { host: host.map(createTestStarterPayload), guest: guest.map(createTestStarterPayload) },
    timedEvent,
  };
}

describe("co-op game start", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override.battleStyle("double").enemyMoveset(MoveId.SPLASH).disableTrainerWaves();
  });

  afterEach(() => {
    setCoopSession(null);
  });

  it("opens the session with both snapshots and the timed event", () => {
    const start = startInfo([SpeciesId.BULBASAUR], [SpeciesId.CHARMANDER], "Some Event");
    const session = beginCoopSession("guest", createLoopbackPair().guest, start);

    expect(coopSession).toBe(session);
    expect(session.localRole).toBe("guest");
    expect(session.getAccountSnapshot("host")).toEqual(snapshot(1));
    expect(session.getAccountSnapshot("guest")).toEqual(snapshot(2));
    expect(session.timedEvent).toBe("Some Event");
  });

  it("creates starters from the shared seed", () => {
    game.scene.gameMode = createCoopGameMode();
    const start = startInfo([SpeciesId.BULBASAUR, SpeciesId.PIKACHU], [SpeciesId.CHARMANDER]);
    beginCoopSession("host", createLoopbackPair().host, start);

    const first = assembleCoopParty(start, 5).map(p => p.id);
    // Whatever happened to the shared RNG before, the shared seed decides the ids.
    randSeedInt(1000);
    const second = assembleCoopParty(start, 5).map(p => p.id);

    expect(new Set(first).size).toBe(3);
    expect(second).toEqual(first);
  });

  it("assembles host picks first on the field", async () => {
    const start = startInfo(
      [SpeciesId.BULBASAUR, SpeciesId.CHARMANDER],
      [SpeciesId.SQUIRTLE, SpeciesId.PIKACHU, SpeciesId.EEVEE],
    );
    await startCoopBattle(game, { role: "host", start });

    const party = game.scene.getPlayerParty();
    expect(party.map(p => p.species.speciesId)).toEqual([
      SpeciesId.BULBASAUR,
      SpeciesId.SQUIRTLE,
      SpeciesId.CHARMANDER,
      SpeciesId.PIKACHU,
      SpeciesId.EEVEE,
    ]);
    expect(party.map(p => coopSession?.ownership.get(p.id))).toEqual(["host", "guest", "host", "guest", "guest"]);
    const field = game.scene.getPlayerField();
    expect(field.map(p => coopSession?.ownership.get(p.id))).toEqual(["host", "guest"]);
    expect(game.scene.gameMode.isCoop).toBe(true);
  });

  it("uses the co-op session slot", async () => {
    game.scene.sessionSlotId = 0;
    await startCoopBattle(game, { role: "guest", start: startInfo([SpeciesId.BULBASAUR], [SpeciesId.CHARMANDER]) });
    expect(game.scene.sessionSlotId).toBe(COOP_SESSION_SLOT);
    expect(COOP_SESSION_SLOT).toBe(5);
  });

  it("starts with the starting money, whatever the screen set before", async () => {
    game.scene.money = 12345;
    await startCoopBattle(game, { role: "host", start: startInfo([SpeciesId.BULBASAUR], [SpeciesId.CHARMANDER]) });
    expect(game.scene.money).toBe(game.scene.gameMode.getStartingMoney());
  });

  describe("timed events", () => {
    const pastEvent = {
      name: "Coop Test Event",
      eventType: EventType.SHINY,
      startDate: new Date(Date.UTC(2000, 0, 1)),
      endDate: new Date(Date.UTC(2000, 0, 2)),
    } as TimedEvent;
    let wasDisabled: boolean;

    beforeEach(() => {
      wasDisabled = timedEventManager["disabled"];
      timedEventManager["disabled"] = false;
    });

    afterEach(() => {
      timedEventManager["disabled"] = wasDisabled;
    });

    it("follows the clock in solo play", () => {
      expect(timedEventManager.isActive(pastEvent)).toBe(false);
    });

    it("uses the host's timed event in co-op", () => {
      beginCoopSession("guest", createLoopbackPair().guest, startInfo([SpeciesId.BULBASAUR], [], pastEvent.name));
      expect(timedEventManager.isActive(pastEvent)).toBe(true);
      expect(timedEventManager.isActive({ ...pastEvent, name: "Other", endDate: new Date(Date.UTC(3000, 0, 1)) })).toBe(
        false,
      );
    });

    it("has no timed event in co-op when the host had none", () => {
      beginCoopSession("guest", createLoopbackPair().guest, startInfo([SpeciesId.BULBASAUR], []));
      expect(timedEventManager.isActive({ ...pastEvent, endDate: new Date(Date.UTC(3000, 0, 1)) })).toBe(false);
    });
  });
});

describe("co-op start end to end", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  const accounts: Record<CoopRole, CoopTestAccount> = {
    host: {
      trainerId: 1111,
      secretId: 2222,
      unlocks: [],
      caughtSpecies: [],
      eggMoves: { [SpeciesId.BULBASAUR]: 0b0001 },
    },
    // Differs from the host in every value the start reads, including Bulbasaur's egg moves.
    guest: {
      trainerId: 3333,
      secretId: 4444,
      unlocks: [Unlockables.EVIOLITE, Unlockables.MINI_BLACK_HOLE],
      caughtSpecies: [SpeciesId.SHELMET, SpeciesId.RESHIRAM],
      eggMoves: { [SpeciesId.BULBASAUR]: 0, [SpeciesId.CHARMANDER]: 0b1111 },
    },
  };

  interface RoleRun {
    party: [id: number, speciesId: SpeciesId, owner: CoopRole | undefined][];
    moves: MoveId[][];
    hash: string;
  }

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  function setUpOverrides(): void {
    game.override.battleStyle("double").enemyMoveset(MoveId.SPLASH).disableTrainerWaves();
    game.override.disableShinies = false;
    game.override.shiny(false);
  }

  /** The host's first pick knows an egg move only the host has unlocked. */
  function hostPicks(): CoopStarterPayload[] {
    const levelMoves = speciesDataRegistry
      .getSpecies(SpeciesId.BULBASAUR)
      .getLevelMoves()
      .filter(([level]) => level <= 5)
      .map(([, move]) => move);
    const moveset = [levelMoves[0], speciesEggMoves[SpeciesId.BULBASAUR][0]];
    return [{ ...createTestStarterPayload(SpeciesId.BULBASAUR), moveset }, createTestStarterPayload(SpeciesId.PIKACHU)];
  }

  async function runRole(
    role: CoopRole,
    start: CoopStartInfo,
    transport: CoopTransport,
    partnerTransport: CoopTransport,
  ): Promise<RoleRun> {
    setUpOverrides();
    applyTestAccount(game.scene.gameData, accounts[role]);
    // The partner's game is not running: answer its wave start "switch?" question for it.
    answerWaveStartSwitches(partnerTransport);
    await startCoopBattle(game, { role, start, transport });
    const party = game.scene.getPlayerParty();
    const run: RoleRun = {
      party: party.map(p => [p.id, p.species.speciesId, coopSession?.ownership.get(p.id)]),
      moves: party.map(p => p.moveset.map(m => m.moveId)),
      hash: computeCoopStateHash(),
    };
    setCoopSession(null);
    return run;
  }

  /** Both players select over a loopback connection, then each role starts its own game from its start message. */
  async function runBothRoles(): Promise<Record<CoopRole, RoleRun>> {
    const { gameData } = game.scene;
    const { starts, transports } = await selectCoopStart({
      host: { picks: hostPicks(), account: snapshotForTestAccount(gameData, accounts.host) },
      // Picking the same species as the partner is allowed.
      guest: {
        picks: [createTestStarterPayload(SpeciesId.CHARMANDER), createTestStarterPayload(SpeciesId.BULBASAUR)],
        account: snapshotForTestAccount(gameData, accounts.guest),
      },
    });
    const host = await runRole("host", starts.host, transports.host, transports.guest);
    game = createFreshGameManager(phaserGame);
    const guest = await runRole("guest", starts.guest, transports.guest, transports.host);
    return { host, guest };
  }

  it("host and guest build the same party from the start message", async () => {
    const { host, guest } = await runBothRoles();

    expect(host.party.map(([, speciesId, owner]) => [speciesId, owner])).toEqual([
      [SpeciesId.BULBASAUR, "host"],
      [SpeciesId.CHARMANDER, "guest"],
      [SpeciesId.PIKACHU, "host"],
      [SpeciesId.BULBASAUR, "guest"],
    ]);
    expect(guest.party).toEqual(host.party);
    expect(guest.moves).toEqual(host.moves);
  });

  it("first wave hash matches between host and guest with different accounts", async () => {
    const { host, guest } = await runBothRoles();

    // Sanity: the host's egg move made it in, so a guest reading its own account would differ.
    expect(host.moves[0]).toContain(speciesEggMoves[SpeciesId.BULBASAUR][0]);
    expect(guest.hash).toBe(host.hash);
  });
});
