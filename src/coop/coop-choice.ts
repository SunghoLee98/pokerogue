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
import { UiMode } from "#enums/ui-mode";
import type { OptionSelectItem, OptionSelectModeConfig } from "#types/ui-types";

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
