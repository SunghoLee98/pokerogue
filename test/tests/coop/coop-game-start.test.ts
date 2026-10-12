import { timedEventManager } from "#app/global-event-manager";
import { assembleCoopParty, beginCoopSession, COOP_SESSION_SLOT, createCoopGameMode } from "#coop/coop-game-start";
import type { CoopAccountSnapshot, CoopStarterPayload } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Gender } from "#data/gender";
import { EventType } from "#enums/event-type";
import { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import { startCoopBattle } from "#test/utils/coop-replay";
import type { TimedEvent } from "#types/game-events";
import { randSeedInt } from "#utils/common";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

function testPick(speciesId: SpeciesId): CoopStarterPayload {
  return {
    speciesId,
    formIndex: 0,
    gender: Gender.MALE,
    shiny: false,
    variant: 0,
    abilityIndex: 0,
    passive: false,
    nature: Nature.HARDY,
    ivs: [20, 20, 20, 20, 20, 20],
    moveset: [],
    teraType: PokemonType.NORMAL,
    friendship: 50,
    pokeball: PokeballType.POKEBALL,
    pokerus: false,
    luck: 0,
  };
}

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
    picks: { host: host.map(testPick), guest: guest.map(testPick) },
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
