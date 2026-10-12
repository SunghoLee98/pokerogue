/**
 * Field slots and switching in co-op (spec 3.3, 3.4, 4.4 "교체").
 *
 * Each player switches only among their own pokemon.
 * @module
 */

import { getPokemonNameWithAffix } from "#app/messages";
import { coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { PartyUiMode } from "#enums/party-ui-mode";
import type { PlayerPokemon } from "#field/pokemon";

/** Party screens in which a player may only pick their own pokemon: sending out, and releasing to make room. */
const OWN_POKEMON_MODES: readonly PartyUiMode[] = [
  PartyUiMode.SWITCH,
  PartyUiMode.FAINT_SWITCH,
  PartyUiMode.POST_BATTLE_SWITCH,
  PartyUiMode.RELEASE,
];

/**
 * Restrict a party screen's choice to the local player's own pokemon where it matters.
 * @param mode - The party screen mode
 * @param filter - The screen's own filter
 * @returns The filter itself outside co-op and for other screens
 */
export function wrapCoopPartyFilter<F extends (pokemon: PlayerPokemon, ...rest: never[]) => string | null>(
  mode: PartyUiMode,
  filter: F,
): F {
  const session = coopSession;
  if (!session || !OWN_POKEMON_MODES.includes(mode)) {
    return filter;
  }
  return ((pokemon: PlayerPokemon, ...rest: never[]) => {
    if ((session.ownership.get(pokemon.id) ?? "host") !== session.localRole) {
      return coopText("partnerPokemon", { pokemonName: getPokemonNameWithAffix(pokemon, false) });
    }
    return filter(pokemon, ...rest);
  }) as F;
}
