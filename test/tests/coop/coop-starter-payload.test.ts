import { speciesDataRegistry } from "#app/global-species-data-registry";
import { speciesEggMoves } from "#balance/moves/egg-moves";
import type { CoopAccountSnapshot, CoopStarterPayload } from "#coop/coop-protocol";
import { CoopSession, setCoopSession } from "#coop/coop-session";
import { buildStarterPayload, createStarterFromPayload } from "#coop/coop-starter-payload";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Gender } from "#data/gender";
import { DexAttr } from "#enums/dex-attr";
import type { MoveId } from "#enums/move-id";
import { Nature } from "#enums/nature";
import { PokeballType } from "#enums/pokeball";
import { PokemonType } from "#enums/pokemon-type";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import type { Starter } from "#types/save-data";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const emptySnapshot = (): CoopAccountSnapshot => ({
  trainerId: 0,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

/** Two of Bulbasaur's level 5 moves and its first egg move */
function bulbasaurMoves(): MoveId[] {
  const levelMoves = speciesDataRegistry
    .getSpecies(SpeciesId.BULBASAUR)
    .getLevelMoves()
    .filter(([level]) => level <= 5)
    .map(([, move]) => move);
  return [levelMoves[0], levelMoves[1], speciesEggMoves[SpeciesId.BULBASAUR][0]];
}

function bulbasaurPayload(): CoopStarterPayload {
  return {
    speciesId: SpeciesId.BULBASAUR,
    formIndex: 0,
    gender: Gender.FEMALE,
    shiny: true,
    variant: 2,
    abilityIndex: 1,
    passive: true,
    nature: Nature.MODEST,
    ivs: [1, 2, 3, 4, 5, 6],
    moveset: bulbasaurMoves(),
    teraType: PokemonType.FIRE,
    friendship: 70,
    pokeball: PokeballType.POKEBALL,
    nickname: "Bulby",
    pokerus: true,
    luck: 3,
  };
}

describe("co-op starter payload", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  function startCoop(role: "host" | "guest", host: CoopAccountSnapshot, guest: CoopAccountSnapshot): CoopSession {
    const session = new CoopSession(role, createLoopbackPair()[role]);
    session.setAccountSnapshot("host", host);
    session.setAccountSnapshot("guest", guest);
    setCoopSession(session);
    return session;
  }

  it("builds a payload from a starter and the local account", () => {
    const { gameData } = game.scene;
    gameData.dexData[SpeciesId.BULBASAUR].caughtAttr =
      DexAttr.SHINY | DexAttr.FEMALE | DexAttr.VARIANT_3 | DexAttr.DEFAULT_FORM;
    const starter: Starter = {
      speciesId: SpeciesId.BULBASAUR,
      shiny: true,
      variant: 2,
      formIndex: 0,
      female: true,
      abilityIndex: 1,
      passive: true,
      nature: Nature.MODEST,
      moveset: bulbasaurMoves() as Starter["moveset"],
      pokerus: true,
      nickname: "Bulby",
      ivs: [1, 2, 3, 4, 5, 6],
    };

    const payload = buildStarterPayload(starter, gameData);

    const { baseFriendship } = speciesDataRegistry.getSpecies(SpeciesId.BULBASAUR);
    expect(payload).toEqual({ ...bulbasaurPayload(), teraType: PokemonType.GRASS, friendship: baseFriendship });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it("uses the genderless and explicit tera type of the starter", () => {
    const starter: Starter = {
      speciesId: SpeciesId.MAGNEMITE,
      shiny: false,
      variant: 0,
      formIndex: 0,
      abilityIndex: 0,
      passive: false,
      nature: Nature.HARDY,
      pokerus: false,
      teraType: PokemonType.WATER,
      ivs: [0, 0, 0, 0, 0, 0],
    };

    const payload = buildStarterPayload(starter, game.scene.gameData);

    expect(payload.gender).toBe(Gender.GENDERLESS);
    expect(payload.teraType).toBe(PokemonType.WATER);
    expect(payload.moveset).toEqual([]);
    expect(payload.nickname).toBeUndefined();
  });

  it("creates the pokemon from the payload only", () => {
    const session = startCoop(
      "guest",
      { ...emptySnapshot(), eggMoves: { [SpeciesId.BULBASAUR]: 0b0001 } },
      emptySnapshot(),
    );
    // The local account knows nothing of the host's unlocks.
    game.scene.gameData.starterData[SpeciesId.BULBASAUR].eggMoves = 0;
    game.scene.gameData.dexData[SpeciesId.BULBASAUR].caughtAttr = DexAttr.NON_SHINY | DexAttr.MALE;
    const payload = bulbasaurPayload();

    const pokemon = createStarterFromPayload(payload, 5, "host");

    expect(session.ownership.get(pokemon.id)).toBe("host");
    expect(pokemon.species.speciesId).toBe(SpeciesId.BULBASAUR);
    expect(pokemon.level).toBe(5);
    expect(pokemon.gender).toBe(Gender.FEMALE);
    expect(pokemon.shiny).toBe(true);
    expect(pokemon.variant).toBe(2);
    expect(pokemon.abilityIndex).toBe(1);
    expect(pokemon.passive).toBe(true);
    expect(pokemon.nature).toBe(Nature.MODEST);
    expect(pokemon.ivs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pokemon.moveset.map(m => m.moveId)).toEqual(payload.moveset);
    expect(pokemon.teraType).toBe(PokemonType.FIRE);
    expect(pokemon.friendship).toBe(70);
    expect(pokemon.pokeball).toBe(PokeballType.POKEBALL);
    expect(pokemon.nickname).toBe("Bulby");
    expect(pokemon.pokerus).toBe(true);
    expect(pokemon.luck).toBe(3);
    expect(pokemon.visible).toBe(false);
  });

  it("rejects an egg move the owner has not unlocked", () => {
    startCoop("host", emptySnapshot(), emptySnapshot());
    // Locally the egg move is unlocked, but the guest who owns the pokemon has not unlocked it.
    game.scene.gameData.starterData[SpeciesId.BULBASAUR].eggMoves = 0b1111;

    const pokemon = createStarterFromPayload(bulbasaurPayload(), 5, "guest");

    expect(pokemon.moveset).toEqual([]);
  });

  it("throws outside co-op", () => {
    expect(() => createStarterFromPayload(bulbasaurPayload(), 5, "host")).toThrow("co-op session");
  });
});
