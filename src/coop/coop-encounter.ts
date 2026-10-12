/**
 * Mystery encounters in co-op (spec 3.10).
 * @module
 */

import { coopSession } from "#coop/coop-session";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";

/**
 * Encounters built for one player that break in co-op (spec 3.10):
 * - Safari Zone: a multi-turn minigame with its own command screen, for one player
 * - The Expert Pokémon Breeder: fights with one chosen pokemon, leaving the other player without one
 * - Fun and Games!: a 1v1 minigame that skips the command screen
 */
const COOP_EXCLUDED_ENCOUNTERS: readonly MysteryEncounterType[] = [
  MysteryEncounterType.SAFARI_ZONE,
  MysteryEncounterType.THE_EXPERT_POKEMON_BREEDER,
  MysteryEncounterType.FUN_AND_GAMES,
];

/** Whether the encounter may not be drawn because co-op leaves it out. Always `false` in solo. */
export function isCoopExcludedEncounter(type: MysteryEncounterType): boolean {
  return coopSession !== null && COOP_EXCLUDED_ENCOUNTERS.includes(type);
}
