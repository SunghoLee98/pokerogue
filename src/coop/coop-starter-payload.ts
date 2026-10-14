/**
 * Starter payloads: what one player sends so both clients can create that player's starters.
 *
 * The owner builds the payload from their own account. Creating the pokemon reads only the payload
 * and the owner's account snapshot, never the local `gameData`, so both clients create the same pokemon.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import type { CoopRole, CoopStarterPayload } from "#coop/coop-protocol";
import { coopSession } from "#coop/coop-session";
import { getPokemonSimData } from "#coop/coop-sim-data";
import { Gender } from "#data/gender";
import { PokeballType } from "#enums/pokeball";
import type { PlayerPokemon } from "#field/pokemon";
import type { GameData } from "#system/game-data";
import type { Starter, StarterMoveset } from "#types/save-data";

/** The parts of the owner's {@linkcode GameData} a payload depends on. */
export type StarterPayloadAccount = Pick<GameData, "dexData" | "getDexAttrLuck">;

/**
 * Turn a starter picked on the starter select screen into a payload, using the owner's (local) account.
 * Mirrors what `SelectStarterPhase.initBattle` derives from the starter and the account in solo play.
 */
export function buildStarterPayload(
  starter: Starter,
  account: StarterPayloadAccount = globalScene.gameData,
): CoopStarterPayload {
  const species = speciesDataRegistry.getSpecies(starter.speciesId);
  let gender = starter.female ? Gender.FEMALE : Gender.MALE;
  if (species.malePercent === null) {
    gender = Gender.GENDERLESS;
  }
  const payload: CoopStarterPayload = {
    speciesId: starter.speciesId,
    formIndex: starter.formIndex,
    gender,
    shiny: starter.shiny,
    variant: starter.variant,
    abilityIndex: starter.abilityIndex,
    passive: starter.passive,
    nature: starter.nature,
    ivs: [...starter.ivs],
    moveset: starter.moveset ? [...starter.moveset] : [],
    teraType: starter.teraType ?? species.type1,
    friendship: species.baseFriendship,
    pokeball: PokeballType.POKEBALL,
    pokerus: starter.pokerus,
    luck: account.getDexAttrLuck(account.dexData[starter.speciesId].caughtAttr),
  };
  if (starter.nickname) {
    payload.nickname = starter.nickname;
  }
  return payload;
}

/**
 * Create a starter from its payload and register its owner.
 * The moveset is validated against the owner's unlocked egg moves from their account snapshot.
 * @param level - The starting level of the run
 * @param owner - Who picked the starter
 * @throws If there is no co-op session
 */
export function createStarterFromPayload(payload: CoopStarterPayload, level: number, owner: CoopRole): PlayerPokemon {
  if (!coopSession) {
    throw new Error("creating a co-op starter needs a co-op session");
  }
  const species = speciesDataRegistry.getSpecies(payload.speciesId);
  const pokemon = globalScene.addPlayerPokemon(
    species,
    level,
    payload.abilityIndex,
    payload.formIndex,
    payload.gender,
    payload.shiny,
    payload.variant,
    [...payload.ivs],
    payload.nature,
  );
  coopSession.ownership.set(pokemon.id, owner);

  if (payload.moveset.length > 0) {
    const moveset = payload.moveset as StarterMoveset;
    const eggMoves = getPokemonSimData(pokemon.id).getEggMoveBits(species.getRootSpeciesId());
    if (pokemon.getSpeciesForm().validateStarterMoveset(moveset, eggMoves)) {
      pokemon.tryPopulateMoveset(moveset, true);
    }
  }
  pokemon.passive = payload.passive;
  pokemon.luck = payload.luck;
  pokemon.pokerus = payload.pokerus;
  if (payload.nickname) {
    pokemon.nickname = payload.nickname;
  }
  pokemon.teraType = payload.teraType;
  pokemon.friendship = payload.friendship;
  pokemon.pokeball = payload.pokeball;
  pokemon.setVisible(false);
  return pokemon;
}
