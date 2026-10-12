/**
 * Mystery encounters in co-op (spec 3.10).
 * @module
 */

import { globalScene } from "#app/global-scene";
import { hideCoopBanner, showCoopBanner } from "#coop/coop-banner";
import { getCoopChooser } from "#coop/coop-choice";
import { listenForCoopPings, sendCoopPing, setCoopListPingHandler } from "#coop/coop-ping";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import type { MysteryEncounterOption } from "#mystery-encounters/mystery-encounter-option";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";

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

/** Set while this client applies the partner's encounter option, so it is not routed again. */
let applyingPartnerOption = false;
/** The session whose next partner option is being waited for. */
let waitingSession: CoopSession | null = null;

/**
 * An encounter option was picked (`MysteryEncounterPhase.handleOptionSelect`).
 * The wave's picker's pick goes to the partner as `meOption`; the other player's pick pings instead.
 * @returns Whether co-op took the pick (the caller must not go on with it)
 */
export function routeCoopEncounterOption(index: number): boolean {
  const session = coopSession;
  if (!session || applyingPartnerOption) {
    return false;
  }
  if (getCoopChooser(session) !== session.localRole) {
    sendCoopPing("encounter", { index });
    return true;
  }
  setCoopListPingHandler(null);
  hideCoopBanner();
  session.inputs.send({ t: "choice", kind: "meOption", wave: globalScene.currentBattle.waveIndex, payload: { index } });
  return false;
}

/**
 * The encounter's options are shown (`MysteryEncounterUiHandler.show`).
 * The picker is shown the partner's pings. The other player waits for the picker's option and takes the same one.
 */
export function coopEncounterOptionsShown(handler: MysteryEncounterUiHandler): void {
  const session = coopSession;
  if (!session) {
    return;
  }
  listenForCoopPings(session);
  if (getCoopChooser(session) === session.localRole) {
    setCoopListPingHandler(index => showCoopBanner(coopText("partnerPingedEncounter", { option: index + 1 })));
    return;
  }
  showCoopBanner(coopText("waitingForPartnerChoice"));
  if (waitingSession === session) {
    // Already waiting (the options were shown again, after checking the party).
    return;
  }
  waitingSession = session;
  session.inputs.waitEncounterOption().then(index => {
    if (waitingSession === session) {
      waitingSession = null;
    }
    const phase = globalScene.phaseManager.getCurrentPhase();
    if (coopSession !== session || !phase.is("MysteryEncounterPhase")) {
      return;
    }
    hideCoopBanner();
    const option = (handler as unknown as { encounterOptions: MysteryEncounterOption[] }).encounterOptions[index];
    applyingPartnerOption = true;
    let taken: boolean;
    try {
      taken = phase.handleOptionSelect(option, index);
    } finally {
      applyingPartnerOption = false;
    }
    if (!taken) {
      // The picker's game refused it too; they pick again.
      coopEncounterOptionsShown(handler);
    }
  });
}
