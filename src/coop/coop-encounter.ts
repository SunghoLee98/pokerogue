/**
 * Mystery encounters in co-op (spec 3.10).
 * @module
 */

import { globalScene } from "#app/global-scene";
import { hideCoopBanner, showCoopBanner } from "#coop/coop-banner";
import { askLocalPlayer, getCoopChooser } from "#coop/coop-choice";
import { listenForCoopPings, sendCoopPing, setCoopListPingHandler } from "#coop/coop-ping";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { MysteryEncounterOption } from "#mystery-encounters/mystery-encounter-option";
import type { MysteryEncounterPhase } from "#phases/mystery-encounter-phases";
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

/** Options whose outcome may hit the partner's pokemon without picking one (spec 3.10). */
function needsPartnerConsent(session: CoopSession, index: number): boolean {
  const encounter = globalScene.currentBattle.mysteryEncounter;
  if (!encounter || index !== 0) {
    return false;
  }
  switch (encounter.encounterType) {
    // A random pokemon is taken away / the whole party is changed.
    case MysteryEncounterType.DARK_DEAL:
    case MysteryEncounterType.WEIRD_DREAM:
      return true;
    // The strongest pokemon is sold: ask when it is the partner's.
    case MysteryEncounterType.AN_OFFER_YOU_CANT_REFUSE: {
      const pokemon = encounter.misc?.pokemon as PlayerPokemon | undefined;
      return !!pokemon && (session.ownership.get(pokemon.id) ?? "host") !== session.localRole;
    }
    default:
      return false;
  }
}

/** The picker's questions to the partner about options, per session. */
interface OptionAsks {
  /** A question is pending */
  asking: boolean;
  /** The option the partner allowed, taken without asking again */
  allowed: number | null;
  nextSeq: number;
}
const optionAsks = new WeakMap<CoopSession, OptionAsks>();
let optionAskSession: CoopSession | null = null;

function getOptionAsks(session: CoopSession): OptionAsks {
  let asks = optionAsks.get(session);
  if (!asks) {
    asks = { asking: false, allowed: null, nextSeq: 0 };
    optionAsks.set(session, asks);
  }
  return asks;
}

/**
 * An encounter option was picked (`MysteryEncounterPhase.handleOptionSelect`).
 * The wave's picker's pick goes to the partner as `meOption`, after the partner allows it if it may hit their pokemon.
 * The other player's pick pings instead.
 * @returns Whether co-op took the pick (the caller must not go on with it)
 */
export function routeCoopEncounterOption(
  phase: MysteryEncounterPhase,
  option: MysteryEncounterOption,
  index: number,
): boolean {
  const session = coopSession;
  if (!session || applyingPartnerOption) {
    return false;
  }
  if (getCoopChooser(session) !== session.localRole) {
    sendCoopPing("encounter", { index });
    return true;
  }
  const asks = getOptionAsks(session);
  if (asks.asking) {
    return true;
  }
  if (asks.allowed !== index && needsPartnerConsent(session, index)) {
    askPartnerAbout(session, phase, option, index);
    return true;
  }
  asks.allowed = null;
  setCoopListPingHandler(null);
  hideCoopBanner();
  session.inputs.send({ t: "choice", kind: "meOption", wave: globalScene.currentBattle.waveIndex, payload: { index } });
  return false;
}

function askPartnerAbout(
  session: CoopSession,
  phase: MysteryEncounterPhase,
  option: MysteryEncounterOption,
  index: number,
): void {
  const asks = getOptionAsks(session);
  const seq = asks.nextSeq++;
  asks.asking = true;
  showCoopBanner(coopText("waitingForOwner"));
  session.inputs.send({
    t: "choice",
    kind: "optionAsk",
    wave: globalScene.currentBattle.waveIndex,
    payload: { seq, index },
  });
  session.inputs.waitConfirm("meOption", seq).then(accepted => {
    asks.asking = false;
    if (coopSession !== session || globalScene.phaseManager.getCurrentPhase() !== phase) {
      return;
    }
    if (!accepted) {
      showCoopBanner(coopText("ownerDeclined"));
      return;
    }
    asks.allowed = index;
    phase.handleOptionSelect(option, index);
  });
}

/** Answer the picker's requests to take an option that may hit the local player's pokemon (once per session). */
function listenForOptionAsks(session: CoopSession): void {
  if (optionAskSession === session) {
    return;
  }
  optionAskSession = session;
  session.inputs.onChoice("optionAsk", message => {
    if (coopSession !== session) {
      return;
    }
    const { seq, index } = message.payload as { seq: number; index: number };
    askLocalPlayer(coopText("partnerOptionAsk", { option: index + 1 }), accepted => {
      session.inputs.send({ t: "confirm", kind: "meOption", wave: message.wave, seq, accepted });
      const phase = globalScene.phaseManager.getCurrentPhase();
      if (phase.is("MysteryEncounterPhase")) {
        globalScene.ui.setMode(UiMode.MYSTERY_ENCOUNTER, phase.optionSelectSettings);
      }
    });
  });
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
  listenForOptionAsks(session);
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
