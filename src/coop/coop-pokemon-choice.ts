/**
 * Choices about one pokemon are made by its owner (spec 3.6): which move to forget for a new one, whether to stop an
 * evolution, and the pokemon picked for a move its owner's pokemon used (Revival Blessing).
 *
 * Both simulations reach these points in the same order, so each takes the session's next decision number. The
 * owner's client asks as in solo and sends the outcome; the partner's client waits for it and applies the same one.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { getPokemonNameWithAffix } from "#app/messages";
import { hideCoopBanner, showCoopBanner } from "#coop/coop-banner";
import { sendCoopDecision } from "#coop/coop-choice";
import type { CoopDecision } from "#coop/coop-protocol";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import type { PartyUiMode } from "#enums/party-ui-mode";
import type { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon, Pokemon } from "#field/pokemon";
import type { Move } from "#moves/move";
import type { LearnMovePhase } from "#phases/learn-move-phase";
import type { ConfirmModeConfig } from "#types/ui-types";
import type { EvolutionSceneUiHandler } from "#ui/evolution-scene-ui-handler";
import type { PartyOption, PokemonSelectFilter } from "#ui/party-ui-handler";
import i18next from "i18next";

function isLocallyOwned(session: CoopSession, pokemon: Pokemon): boolean {
  return (session.ownership.get(pokemon.id) ?? "host") === session.localRole;
}

/** Wait for the partner's decision of the expected kind. */
async function waitFor<K extends CoopDecision["kind"]>(
  session: CoopSession,
  seq: number,
  kind: K,
): Promise<Extract<CoopDecision, { kind: K }> | null> {
  const decision = await session.inputs.waitDecision(seq);
  if (coopSession !== session) {
    return null;
  }
  if (decision.kind !== kind) {
    throw new Error(`expected the partner's ${kind} choice ${seq}, got ${decision.kind}`);
  }
  return decision as Extract<CoopDecision, { kind: K }>;
}

// #region Learning a move

interface LearnMoveChoice {
  session: CoopSession;
  seq: number;
  /** The move slot the new move went into, `-1` if none */
  moveIndex: number;
}

/** Choices the local owner is making, reported when the phase ends. */
const learnMoveChoices = new WeakMap<LearnMovePhase, LearnMoveChoice>();

/**
 * A pokemon with four moves is about to be asked whether to forget one (`LearnMovePhase.start`).
 * @returns Whether co-op took over: on the partner's client, which waits for the owner's choice and applies it
 */
export function awaitCoopLearnMove(phase: LearnMovePhase, pokemon: Pokemon, move: Move): boolean {
  const session = coopSession;
  if (!session) {
    return false;
  }
  const seq = session.nextDecisionSeq();
  if (isLocallyOwned(session, pokemon)) {
    learnMoveChoices.set(phase, { session, seq, moveIndex: -1 });
    return false;
  }
  globalScene.ui.showText(coopText("waitingForPartnerChoice"));
  waitFor(session, seq, "learnMove").then(decision => {
    if (!decision) {
      return;
    }
    const ui = globalScene.ui;
    ui.showText("", 0);
    const pokemonName = getPokemonNameWithAffix(pokemon);
    if (decision.moveIndex < 0) {
      ui.showTextPromise(i18next.t("battle:learnMoveNotLearned", { pokemonName, moveName: move.name }), undefined, true) //
        .then(() => phase.end());
      return;
    }
    const forgotten = pokemon.moveset[decision.moveIndex]!.getName();
    const text = [
      i18next.t("battle:countdownPoof"),
      i18next.t("battle:learnMoveForgetSuccess", { pokemonName, moveName: forgotten }),
      i18next.t("battle:learnMoveAnd"),
    ].join("$");
    (phase as unknown as { learnMove: (i: number, m: Move, p: Pokemon, t?: string) => void }).learnMove(
      decision.moveIndex,
      move,
      pokemon,
      text,
    );
  });
  return true;
}

/** The owner's pokemon learned the move into this slot (`LearnMovePhase.learnMove`). */
export function noteCoopLearnedMove(phase: LearnMovePhase, moveIndex: number): void {
  const choice = learnMoveChoices.get(phase);
  if (choice) {
    choice.moveIndex = moveIndex;
  }
}

/** The phase ends: tell the partner what the owner chose. */
export function reportCoopLearnMove(phase: LearnMovePhase): void {
  const choice = learnMoveChoices.get(phase);
  if (choice && coopSession === choice.session) {
    learnMoveChoices.delete(phase);
    sendCoopDecision(choice.session, { kind: "learnMove", seq: choice.seq, moveIndex: choice.moveIndex });
  }
}

// #endregion
// #region Evolving

/** Whether the local player may stop this pokemon's evolution: only its owner may. */
export function coopMayCancelEvolution(pokemon: Pokemon): boolean {
  return !coopSession || isLocallyOwned(coopSession, pokemon);
}

/**
 * The evolution animation finished: settle whether it was stopped.
 * The owner's client reports its player's choice; the partner's client takes it over.
 */
export async function settleCoopEvolutionCancel(pokemon: Pokemon, handler: EvolutionSceneUiHandler): Promise<void> {
  const session = coopSession;
  if (!session) {
    return;
  }
  const seq = session.nextDecisionSeq();
  if (isLocallyOwned(session, pokemon)) {
    sendCoopDecision(session, { kind: "evolution", seq, cancelled: handler.cancelled, paused: false });
    return;
  }
  const decision = await waitFor(session, seq, "evolution");
  if (decision) {
    handler.cancelled = decision.cancelled;
  }
}

/**
 * The owner is asked whether to pause further evolutions after stopping one.
 * @param options - The question's answers as the solo game has them
 * @param end - Ends the phase
 * @param pokemonName - The name before evolving
 * @returns The answers to show (reporting the choice in co-op), or `null` on the partner's client, which applies the
 *   owner's choice instead
 */
export function routeCoopEvolutionPause(
  pokemon: PlayerPokemon,
  options: ConfirmModeConfig,
  end: () => void,
  pokemonName: string,
): ConfirmModeConfig | null {
  const session = coopSession;
  if (!session) {
    return options;
  }
  const seq = session.nextDecisionSeq();
  if (isLocallyOwned(session, pokemon)) {
    const report = (paused: boolean) => sendCoopDecision(session, { kind: "evolution", seq, cancelled: true, paused });
    return {
      ...options,
      yesHandler: () => {
        report(true);
        return options.yesHandler();
      },
      noHandler: () => {
        report(false);
        return options.noHandler();
      },
    };
  }
  waitFor(session, seq, "evolution").then(decision => {
    if (!decision) {
      return;
    }
    // As the answers do, without the question shown.
    if (decision.paused) {
      pokemon.pauseEvolutions = true;
      globalScene.ui.showText(i18next.t("menu:evolutionsPaused", { pokemonName }), null, end, 3000);
    } else {
      globalScene.time.delayedCall(3000, end);
    }
  });
  return null;
}

// #endregion
// #region Party picks for a move

export type CoopPartyPickCallback = (slotIndex: number, option: PartyOption) => void;

/**
 * Open the party screen for a pick made for a move (Revival Blessing), in place of
 * `globalScene.ui.setMode(mode, partyUiMode, fieldIndex, callback, filter)`. The move user's owner picks.
 * @param user - The pokemon that used the move
 */
export function setCoopOwnerPartyMode(
  user: Pokemon,
  mode: UiMode,
  partyUiMode: PartyUiMode,
  fieldIndex: number,
  callback: CoopPartyPickCallback,
  filter?: PokemonSelectFilter,
): Promise<void> {
  const session = coopSession;
  if (!session) {
    return globalScene.ui.setMode(mode, partyUiMode, fieldIndex, callback, filter);
  }
  const seq = session.nextDecisionSeq();
  if (isLocallyOwned(session, user)) {
    const pick: CoopPartyPickCallback = (slotIndex, option) => {
      sendCoopDecision(session, { kind: "partyPick", seq, slotIndex, option });
      callback(slotIndex, option);
    };
    return globalScene.ui.setMode(mode, partyUiMode, fieldIndex, pick, filter);
  }
  showCoopBanner(coopText("waitingForPartnerChoice"));
  waitFor(session, seq, "partyPick").then(decision => {
    if (decision) {
      hideCoopBanner();
      callback(decision.slotIndex, decision.option);
    }
  });
  return Promise.resolve();
}

// #endregion
