/**
 * Field slots and switching in co-op (spec 3.3, 3.4, 4.4 "교체").
 *
 * Field slot 0 is the host's and slot 1 the guest's. Each player switches only among their own pokemon, and a slot
 * whose player has no pokemon left stays empty while the partner fights alone (support mode).
 * @module
 */

import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import type { CoopDecision, CoopRole } from "#coop/coop-protocol";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { FieldPosition } from "#enums/field-position";
import { PartyUiMode } from "#enums/party-ui-mode";
import type { PlayerPokemon, Pokemon } from "#field/pokemon";
import type { PartyOption } from "#ui/party-ui-handler";

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
    if (ownerOf(session, pokemon) !== session.localRole) {
      return coopText("partnerPokemon", { pokemonName: getPokemonNameWithAffix(pokemon, false) });
    }
    return filter(pokemon, ...rest);
  }) as F;
}

/** The owner of a party pokemon; pokemon without a recorded owner count as the host's. */
function ownerOf(session: CoopSession, pokemon: PlayerPokemon): CoopRole {
  return session.ownership.get(pokemon.id) ?? "host";
}

/** The field slot each player's pokemon stands in (spec 3.3). */
const SLOT_ORDER: readonly CoopRole[] = ["host", "guest"];

/**
 * Order the party for a new wave so that field slot 0 holds the host's pokemon and slot 1 the guest's (spec 4.4).
 * A player's pokemon already on the field stays; otherwise their first living pokemon is used.
 * A player with no living pokemon keeps one of their fainted pokemon in their slot, so the slot stays empty
 * instead of taking the partner's next pokemon (spec 3.4).
 * @returns The pokemon to stand in each slot (`undefined` for an empty slot), or `null` if the party has no fainted
 *   pokemon to hold an empty slot (the solo order is used then)
 */
export function arrangeCoopParty(session: CoopSession): (PlayerPokemon | undefined)[] | null {
  const party = globalScene.getPlayerParty();
  const fighters = SLOT_ORDER.map(role => {
    const own = party.filter(p => ownerOf(session, p) === role && p.isAllowedInBattle());
    return own.find(p => p.isOnField()) ?? own[0];
  });
  const slots: PlayerPokemon[] = [];
  for (const [index, role] of SLOT_ORDER.entries()) {
    const holder =
      fighters[index]
      ?? party.find(p => ownerOf(session, p) === role && !p.isAllowedInBattle())
      ?? party.find(p => !p.isAllowedInBattle() && !slots.includes(p));
    if (!holder) {
      return null;
    }
    slots.push(holder);
  }
  const rest = party.filter(p => !slots.includes(p));
  party.splice(0, party.length, ...slots, ...rest);
  return fighters;
}

/**
 * Queue the summons at the start of a co-op wave, in place of the solo "send out the first two living pokemon".
 * Each player's slot gets their own pokemon (see {@linkcode arrangeCoopParty}); a wiped player's slot stays empty.
 * There is no "switch?" question: it depends on each client's battle style setting, so the clients could disagree.
 * @returns Whether co-op queued the summons (the caller must skip its own)
 */
export function queueCoopFieldSummons(): boolean {
  const session = coopSession;
  if (!session) {
    return false;
  }
  const fighters = arrangeCoopParty(session);
  if (!fighters) {
    return false;
  }
  const { phaseManager } = globalScene;
  const [first, second] = fighters;
  if (first && second) {
    // Keep both on their own side when the order changed under pokemon already out.
    first.isOnField() && first.setFieldPosition(FieldPosition.LEFT);
    second.isOnField() && second.setFieldPosition(FieldPosition.RIGHT);
  }
  if (first && !first.isOnField()) {
    phaseManager.pushNew("SummonPhase", 0);
  }
  if (first && second) {
    phaseManager.pushNew("ToggleDoublePositionPhase", true);
  }
  if (second && !second.isOnField()) {
    phaseManager.pushNew("SummonPhase", 1);
  }
  return true;
}

/**
 * The pokemon that may replace a fainted one: in co-op only its owner's (spec 3.4).
 * @param fainted - The fainted player pokemon
 * @param candidates - The living pokemon off the field
 */
export function filterCoopReplacements(fainted: Pokemon, candidates: PlayerPokemon[]): PlayerPokemon[] {
  const session = coopSession;
  if (!session || !fainted.isPlayer()) {
    return candidates;
  }
  const owner = ownerOf(session, fainted as PlayerPokemon);
  return candidates.filter(p => ownerOf(session, p) === owner);
}

export type CoopSwitchSelect = (slotIndex: number, option: PartyOption) => void;

/**
 * Route a switch-in choice to the owner of the pokemon leaving the slot.
 * @param fieldIndex - The field slot being switched
 * @param select - What the switch does with the choice
 * @returns The callback for the party screen (reporting the choice in co-op), or `null` on the partner's client,
 *   which waits for the owner's choice and applies it instead of opening the party screen
 */
export function routeCoopSwitch(fieldIndex: number, select: CoopSwitchSelect): CoopSwitchSelect | null {
  const session = coopSession;
  if (!session) {
    return select;
  }
  const seq = session.nextDecisionSeq();
  const leaving = globalScene.getPlayerField()[fieldIndex];
  if (!leaving || ownerOf(session, leaving) === session.localRole) {
    return (slotIndex, option) => {
      const decision: CoopDecision = { kind: "switch", seq, slotIndex, option };
      session.inputs.send({
        t: "choice",
        kind: "switch",
        wave: globalScene.currentBattle.waveIndex,
        payload: decision,
      });
      select(slotIndex, option);
    };
  }
  globalScene.ui.showText(coopText("waitingForPartnerChoice"));
  session.inputs.waitDecision(seq).then(decision => {
    if (coopSession !== session) {
      return;
    }
    if (decision.kind !== "switch") {
      throw new Error(`expected the partner's switch choice ${seq}, got ${decision.kind}`);
    }
    select(decision.slotIndex, decision.option);
  });
  return null;
}
