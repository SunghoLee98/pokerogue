/**
 * Choices one player makes for both (spec 3.6): the next biome, an encounter's follow-up options and party picks.
 *
 * Both simulations reach these choices at the same points, so each takes the session's next decision number.
 * The chooser uses the usual screen and sends what they picked; the other player sees the same screen, where picking
 * pings instead, and applies the chooser's pick when it arrives.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { hideCoopBanner, showCoopBanner } from "#coop/coop-banner";
import { listenForCoopPings, sendCoopPing, setCoopListPingHandler } from "#coop/coop-ping";
import type { CoopDecision, CoopRole } from "#coop/coop-protocol";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { PartyUiMode } from "#enums/party-ui-mode";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { OptionSelectItem, OptionSelectModeConfig } from "#types/ui-types";
import { PartyOption, type PokemonSelectFilter } from "#ui/party-ui-handler";

/** The player who chooses for both at this point of the wave: the wave's picker (spec 3.5, 3.6). */
export function getCoopChooser(session: CoopSession): CoopRole {
  return session.pickerForWave(globalScene.currentBattle.waveIndex);
}

/** Send a decision to the partner's client. */
export function sendCoopDecision(session: CoopSession, decision: CoopDecision): void {
  session.inputs.send({
    t: "choice",
    kind: decision.kind,
    wave: globalScene.currentBattle.waveIndex,
    payload: decision,
  });
}

/**
 * Route a list of options (`OPTION_SELECT`) to the player who chooses.
 * @param config - The list as the solo game shows it
 * @param chooser - Who chooses. Default: the wave's picker
 * @returns The list to show: the chooser's reports their pick, the other player's pings and follows the chooser.
 *   The config itself outside co-op.
 */
export function routeCoopOptionSelect(config: OptionSelectModeConfig, chooser?: CoopRole): OptionSelectModeConfig {
  const session = coopSession;
  if (!session) {
    return config;
  }
  const seq = session.nextDecisionSeq();
  listenForCoopPings(session);
  if ((chooser ?? getCoopChooser(session)) === session.localRole) {
    setCoopListPingHandler(index => {
      const label = config.options[index]?.label;
      if (label !== undefined) {
        showCoopBanner(coopText("partnerPingedOption", { option: label }));
      }
    });
    return {
      ...config,
      options: config.options.map((option, index) => ({
        ...option,
        handler: () => {
          const chosen = option.handler();
          if (chosen) {
            setCoopListPingHandler(null);
            hideCoopBanner();
            sendCoopDecision(session, { kind: "option", seq, index });
          }
          return chosen;
        },
      })),
    };
  }
  showCoopBanner(coopText("waitingForPartnerChoice"));
  session.inputs.waitDecision(seq).then(decision => {
    if (coopSession !== session) {
      return;
    }
    if (decision.kind !== "option") {
      throw new Error(`expected the partner's option ${seq}, got ${decision.kind}`);
    }
    hideCoopBanner();
    applyOption(config.options[decision.index]);
  });
  return {
    ...config,
    options: config.options.map((option, index) => ({
      ...option,
      handler: () => {
        sendCoopPing("option", { index });
        return false;
      },
    })),
  };
}

/** Pick an option for the partner, as the list would on a press. */
function applyOption(option: OptionSelectItem | undefined): void {
  if (!option?.handler() || option.keepOpen) {
    return;
  }
  if (globalScene.ui.mode === UiMode.OPTION_SELECT) {
    globalScene.ui.getHandler().clear();
  }
}

export type CoopPartySelectCallback = (slotIndex: number, option: PartyOption) => void;

let ownerAskSession: CoopSession | null = null;

/**
 * Open the party screen for an encounter's pokemon pick (spec 3.6, 3.10), in place of
 * `globalScene.ui.setMode(UiMode.PARTY, PartyUiMode.SELECT, -1, callback, filter)`.
 * The wave's picker picks from all six. Picking the partner's pokemon asks the partner first; if they decline, the
 * party screen opens again. The other player waits, answers when asked about one of their pokemon, and applies the
 * pick when it arrives.
 * @param callback - What the pick does
 * @param filter - Which pokemon may be picked
 */
export function setCoopPartySelectMode(
  _mode: UiMode,
  _partyUiMode: PartyUiMode,
  _fieldIndex: number,
  callback: CoopPartySelectCallback,
  filter?: PokemonSelectFilter,
): Promise<void> {
  const open = (select: CoopPartySelectCallback) =>
    globalScene.ui.setMode(UiMode.PARTY, PartyUiMode.SELECT, -1, select, filter);
  const session = coopSession;
  if (!session) {
    return open(callback);
  }
  const seq = session.nextDecisionSeq();
  if (getCoopChooser(session) === session.localRole) {
    const pick: CoopPartySelectCallback = (slotIndex, option) => {
      const pokemon = globalScene.getPlayerParty()[slotIndex];
      if (!pokemon || ownerOf(session, pokemon) === session.localRole) {
        sendCoopDecision(session, { kind: "partySelect", seq, slot: slotIndex });
        callback(slotIndex, option);
        return;
      }
      askOwner(session, seq, slotIndex).then(accepted => {
        if (coopSession !== session) {
          return;
        }
        if (accepted) {
          sendCoopDecision(session, { kind: "partySelect", seq, slot: slotIndex });
          callback(slotIndex, option);
          return;
        }
        globalScene.ui.showText(coopText("ownerDeclined"), null, () => open(pick), null, true);
      });
    };
    return open(pick);
  }
  listenForOwnerAsks(session);
  showCoopBanner(coopText("waitingForPartnerChoice"));
  session.inputs.waitDecision(seq).then(decision => {
    if (coopSession !== session) {
      return;
    }
    if (decision.kind !== "partySelect") {
      throw new Error(`expected the partner's party pick ${seq}, got ${decision.kind}`);
    }
    hideCoopBanner();
    callback(decision.slot, PartyOption.SELECT);
  });
  return Promise.resolve();
}

function ownerOf(session: CoopSession, pokemon: PlayerPokemon): CoopRole {
  return session.ownership.get(pokemon.id) ?? "host";
}

/** Ask the partner whether their pokemon may be used, and wait for the answer. */
async function askOwner(session: CoopSession, seq: number, slot: number): Promise<boolean> {
  const ui = globalScene.ui;
  // Leave the party screen first, so it can be opened again if the partner declines.
  await ui.setMode(UiMode.MESSAGE);
  ui.showText(coopText("waitingForOwner"));
  session.inputs.send({
    t: "choice",
    kind: "ownerAsk",
    wave: globalScene.currentBattle.waveIndex,
    payload: { seq, slot },
  });
  return session.inputs.waitConfirm("mePokemon", seq);
}

/** Answer the partner's requests to use the local player's pokemon (once per session). */
function listenForOwnerAsks(session: CoopSession): void {
  if (ownerAskSession === session) {
    return;
  }
  ownerAskSession = session;
  session.inputs.onChoice("ownerAsk", message => {
    if (coopSession !== session) {
      return;
    }
    const { seq, slot } = message.payload as { seq: number; slot: number };
    const pokemon = globalScene.getPlayerParty()[slot];
    askLocalPlayer(coopText("ownerAsk", { pokemonName: pokemon?.getNameToRender() ?? "" }), accepted => {
      session.inputs.send({ t: "confirm", kind: "mePokemon", wave: message.wave, seq, accepted });
      showCoopBanner(coopText("waitingForPartnerChoice"));
    });
  });
}

/** Ask the local player a yes/no question for the partner. */
export function askLocalPlayer(question: string, answer: (accepted: boolean) => void): void {
  const ui = globalScene.ui;
  const reply = (accepted: boolean) => {
    ui.setMode(UiMode.MESSAGE).then(() => ui.showText("", 0));
    answer(accepted);
  };
  ui.setMode(UiMode.MESSAGE).then(() => {
    ui.showText(question);
    ui.setModeWithoutClear(UiMode.CONFIRM, { yesHandler: () => reply(true), noHandler: () => reply(false) });
  });
}
