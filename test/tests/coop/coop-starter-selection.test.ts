import type { CoopAccountSnapshot, CoopStarterPayload } from "#coop/coop-protocol";
import { CoopStarterSelection, type CoopStartInfo } from "#coop/coop-starter-selection";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Gender } from "#data/gender";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { FREE_POINTS } from "#test/utils/coop-replay";
import { afterEach, describe, expect, it } from "vitest";

function pick(speciesId: SpeciesId): CoopStarterPayload {
  return {
    speciesId,
    formIndex: 0,
    gender: Gender.MALE,
    shiny: false,
    variant: 0,
    abilityIndex: 0,
    passive: false,
    nature: Nature.HARDY,
    ivs: [10, 10, 10, 10, 10, 10],
    moveset: [],
    teraType: PokemonType.NORMAL,
    friendship: 50,
    pokeball: PokeballType.POKEBALL,
    pokerus: false,
    luck: 0,
  };
}

function account(trainerId: number): CoopAccountSnapshot {
  return { trainerId, secretId: trainerId + 1, caughtSpecies: [trainerId], eggMoves: {}, unlocks: [] };
}

/** Let the loopback deliver everything that was sent. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe("CoopStarterSelection", () => {
  const selections: CoopStarterSelection[] = [];

  afterEach(() => {
    for (const selection of selections.splice(0)) {
      selection.dispose();
    }
  });

  async function connect(): Promise<{
    host: CoopStarterSelection;
    guest: CoopStarterSelection;
    transports: { host: CoopTransport; guest: CoopTransport };
  }> {
    const transports = createLoopbackPair();
    const { joinCode } = await transports.host.host();
    await transports.guest.join(joinCode);
    const host = new CoopStarterSelection("host", transports.host, {
      getAccount: () => account(1),
      createSeed: () => "shared-seed",
      getTimedEvent: () => "Some Event",
    });
    const guest = new CoopStarterSelection("guest", transports.guest, {
      getAccount: () => account(2),
      createSeed: () => "guest-seed-is-never-used",
      getTimedEvent: () => null,
    });
    selections.push(host, guest);
    return { host, guest, transports };
  }

  function collectStarts(selection: CoopStarterSelection): CoopStartInfo[] {
    const starts: CoopStartInfo[] = [];
    selection.onStart(info => starts.push(info));
    return starts;
  }

  it("shares the party before ready", async () => {
    const { host, guest } = await connect();
    await flush();
    expect(host.partner).toEqual({ picks: [], ready: false, cost: 0 });

    guest.setPicks([pick(SpeciesId.CHARMANDER)], { cost: 3, limit: 10 });
    await flush();
    expect(host.partner).toEqual({ picks: [pick(SpeciesId.CHARMANDER)], ready: false, cost: 3 });

    guest.setPicks([], { cost: 0, limit: 10 });
    await flush();
    expect(host.partner).toEqual({ picks: [], ready: false, cost: 0 });
  });

  it("confirms the picks on ready", async () => {
    const { host, guest } = await connect();
    guest.setReady([pick(SpeciesId.CHARMANDER)], FREE_POINTS);
    await flush();

    expect(host.partner).toEqual({ picks: [pick(SpeciesId.CHARMANDER)], ready: true, cost: 0 });
    expect(guest.localReady).toBe(true);
  });

  it("keeps the partner picks on unready", async () => {
    const { host, guest } = await connect();
    guest.setReady([pick(SpeciesId.CHARMANDER)], { cost: 3, limit: 10 });
    await flush();

    expect(guest.cancelReady()).toBe(true);
    await flush();

    expect(guest.localReady).toBe(false);
    expect(host.partner).toEqual({ picks: [pick(SpeciesId.CHARMANDER)], ready: false, cost: 3 });
  });

  it("ignores party changes while ready", async () => {
    const { host, guest } = await connect();
    guest.setReady([pick(SpeciesId.CHARMANDER)], { cost: 3, limit: 10 });
    guest.setPicks([], { cost: 0, limit: 10 });
    await flush();

    expect(host.partner).toEqual({ picks: [pick(SpeciesId.CHARMANDER)], ready: true, cost: 3 });
  });

  it("notifies changes", async () => {
    const { host, guest } = await connect();
    let changes = 0;
    host.onChange(() => changes++);
    guest.setReady([pick(SpeciesId.CHARMANDER)], FREE_POINTS);
    await flush();
    expect(changes).toBe(1);
  });

  it("starts when both are ready", async () => {
    const { host, guest } = await connect();
    const hostStarts = collectStarts(host);
    const guestStarts = collectStarts(guest);

    host.setReady([pick(SpeciesId.BULBASAUR), pick(SpeciesId.PIKACHU)], FREE_POINTS);
    await flush();
    expect(hostStarts).toEqual([]);
    guest.setReady([pick(SpeciesId.CHARMANDER)], FREE_POINTS);
    await flush();

    const expected: CoopStartInfo = {
      seed: "shared-seed",
      accounts: { host: account(1), guest: account(2) },
      picks: {
        host: [pick(SpeciesId.BULBASAUR), pick(SpeciesId.PIKACHU)],
        guest: [pick(SpeciesId.CHARMANDER)],
      },
      timedEvent: "Some Event",
    };
    expect(hostStarts).toEqual([expected]);
    expect(guestStarts).toEqual([expected]);
    expect(host.startInfo).toEqual(expected);
    expect(guest.startInfo).toEqual(expected);
  });

  it("allows cancelling ready while the partner is still picking", async () => {
    const { host, guest } = await connect();
    host.setReady([pick(SpeciesId.BULBASAUR)], FREE_POINTS);
    await flush();
    expect(host.cancelReady()).toBe(true);
    host.setReady([pick(SpeciesId.SQUIRTLE)], FREE_POINTS);
    guest.setReady([pick(SpeciesId.CHARMANDER)], FREE_POINTS);
    await flush();

    expect(guest.startInfo?.picks.host).toEqual([pick(SpeciesId.SQUIRTLE)]);
  });

  it("allows the same pokemon for both players", async () => {
    const { host, guest } = await connect();
    host.setReady([pick(SpeciesId.PIKACHU)], FREE_POINTS);
    guest.setReady([pick(SpeciesId.PIKACHU)], FREE_POINTS);
    await flush();

    expect(guest.startInfo?.picks).toEqual({ host: [pick(SpeciesId.PIKACHU)], guest: [pick(SpeciesId.PIKACHU)] });
  });

  it("the host start wins over a crossing unready", async () => {
    const { host, guest } = await connect();
    const guestStarts = collectStarts(guest);
    host.setReady([pick(SpeciesId.BULBASAUR)], FREE_POINTS);
    await flush();

    // The guest takes back its ready before the host has seen it; the host starts anyway.
    guest.setReady([pick(SpeciesId.CHARMANDER)], FREE_POINTS);
    expect(guest.cancelReady()).toBe(true);
    await flush();
    await flush();

    expect(host.startInfo?.picks.guest).toEqual([pick(SpeciesId.CHARMANDER)]);
    expect(guestStarts).toHaveLength(1);
    expect(guest.startInfo).toEqual(host.startInfo);
    expect(guest.cancelReady()).toBe(false);
  });

  it("takes a ready player's picks out of the shared budget", async () => {
    const { host, guest } = await connect();
    host.setReady([pick(SpeciesId.MEWTWO)], { cost: 7, limit: 10 });
    await flush();

    expect(guest.partner.cost).toBe(7);
    expect(() => guest.setReady([pick(SpeciesId.CHARMANDER)], { cost: 4, limit: 10 })).toThrow();
    expect(guest.localReady).toBe(false);

    guest.setReady([pick(SpeciesId.CHARMANDER)], { cost: 3, limit: 10 });
    await flush();
    expect(guest.startInfo?.picks).toEqual({ host: [pick(SpeciesId.MEWTWO)], guest: [pick(SpeciesId.CHARMANDER)] });
  });

  it("takes the partner's party out of the budget before ready", async () => {
    const { host, guest } = await connect();
    host.setPicks([pick(SpeciesId.MEWTWO)], { cost: 7, limit: 10 });
    await flush();

    expect(() => guest.setReady([pick(SpeciesId.CHARMANDER)], { cost: 4, limit: 10 })).toThrow();

    host.setPicks([], { cost: 0, limit: 10 });
    await flush();
    guest.setReady([pick(SpeciesId.CHARMANDER)], { cost: 4, limit: 10 });
    expect(guest.localReady).toBe(true);
  });

  it("makes the guest give way when both ready over the budget at once", async () => {
    const { host, guest } = await connect();
    const hostStarts = collectStarts(host);
    host.setReady([pick(SpeciesId.MEWTWO)], { cost: 6, limit: 10 });
    guest.setReady([pick(SpeciesId.RAYQUAZA)], { cost: 6, limit: 10 });
    await flush();
    await flush();

    expect(hostStarts).toEqual([]);
    expect(guest.localReady).toBe(false);
    expect(guest.readyYielded).toBe(true);
    expect(host.localReady).toBe(true);
    expect(host.partner).toEqual({ picks: [pick(SpeciesId.RAYQUAZA)], ready: false, cost: 6 });

    guest.setReady([pick(SpeciesId.CHARMANDER)], { cost: 4, limit: 10 });
    expect(guest.readyYielded).toBe(false);
    await flush();
    expect(host.startInfo?.picks).toEqual({ host: [pick(SpeciesId.MEWTWO)], guest: [pick(SpeciesId.CHARMANDER)] });
  });

  it("rejects an empty selection or more than three picks", async () => {
    const { host } = await connect();
    expect(() => host.setReady([], FREE_POINTS)).toThrow();
    expect(() =>
      host.setReady(
        [pick(SpeciesId.BULBASAUR), pick(SpeciesId.IVYSAUR), pick(SpeciesId.VENUSAUR), pick(SpeciesId.MEW)],
        FREE_POINTS,
      ),
    ).toThrow();
    expect(host.localReady).toBe(false);
  });

  it("marks the selection closed when the peer leaves", async () => {
    const { host, transports } = await connect();
    let changed = false;
    host.onChange(() => (changed = true));
    transports.guest.close();
    await flush();

    expect(host.closed).toBe(true);
    expect(changed).toBe(true);
    expect(() => host.setReady([pick(SpeciesId.BULBASAUR)], FREE_POINTS)).toThrow();
  });

  it("marks the selection closed on bye", async () => {
    const { host, transports } = await connect();
    transports.guest.send({ t: "bye" });
    await flush();

    expect(host.closed).toBe(true);
  });
});
