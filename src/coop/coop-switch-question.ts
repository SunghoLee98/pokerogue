/**
 * The "switch?" question at the start of a co-op wave (`CheckSwitchPhase`).
 * @module
 */

import { globalScene } from "#app/global-scene";
import { settings } from "#app/global-settings-manager";
import { getPokemonNameWithAffix } from "#app/messages";
import { ownerOf } from "#coop/coop-field";
import type { CoopDecision } from "#coop/coop-protocol";
import { coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { BattleStyle } from "#enums/battle-style";
import { BattlerTagType } from "#enums/battler-tag-type";
import { PartyUiMode } from "#enums/party-ui-mode";
import { SwitchType } from "#enums/switch-type";
import { UiMode } from "#enums/ui-mode";
import { PartyUiHandler } from "#ui/party-ui-handler";
import i18next from "i18next";

/**
 * Run the wave start "switch?" question (`CheckSwitchPhase`) for co-op: only the owner of the pokemon in the slot is
 * asked, and only if their own battle style is "Switch", and they may only send out their own pokemon.
 *
 * The battle style is a local setting, so the owner's client alone decides whether to ask: it always sends its answer
 * as a decision (a stay when it did not ask), and the partner's client waits for that decision instead of reading its
 * own setting. Everything before the decision depends only on the shared game state, so both clients count the same
 * decision numbers.
 * @param fieldIndex - The slot asked about
 * @param end - Ends the phase
 * @returns Whether co-op took over the phase (`false` outside co-op)
 */
export function takeOverCoopSwitchQuestion(fieldIndex: number, end: () => void): boolean {
  const session = coopSession;
  if (!session) {
    return false;
  }
  const { phaseManager, ui } = globalScene;
  const pokemon = globalScene.getPlayerField()[fieldIndex];
  // An empty slot (support mode) holds a fainted pokemon: nobody to ask about.
  if (!pokemon?.isAllowedInBattle()) {
    end();
    return true;
  }
  if (!pokemon.isOnField()) {
    phaseManager.unshiftNew("SummonMissingPhase", fieldIndex);
    end();
    return true;
  }
  const owner = ownerOf(session, pokemon);
  const hasBench = globalScene
    .getPlayerParty()
    .some(p => p !== pokemon && ownerOf(session, p) === owner && p.isAllowedInBattle() && !p.isOnField());
  if (
    !hasBench
    || pokemon.getTag(BattlerTagType.FRENZY)
    || pokemon.isTrapped()
    || globalScene.getPlayerField().some(p => p.getTag(BattlerTagType.COMMANDED))
  ) {
    end();
    return true;
  }

  const seq = session.nextDecisionSeq();
  const apply = (slotIndex: number) => {
    if (slotIndex >= globalScene.currentBattle.getBattlerCount() && slotIndex < 6) {
      phaseManager.unshiftNew("SwitchSummonPhase", SwitchType.INITIAL_SWITCH, fieldIndex, slotIndex, true);
    }
    end();
  };

  if (owner !== session.localRole) {
    ui.showText(coopText("waitingForPartnerChoice"));
    session.inputs.waitDecision(seq).then(decision => {
      if (coopSession !== session) {
        return;
      }
      if (decision.kind !== "waveStartSwitch") {
        throw new Error(`expected the partner's wave start switch choice ${seq}, got ${decision.kind}`);
      }
      // `clearText` would be refilled by the text still being typed.
      ui.showText("", 0);
      apply(decision.slotIndex);
    });
    return true;
  }

  const answer = (slotIndex: number) => {
    const decision: CoopDecision = { kind: "waveStartSwitch", seq, slotIndex };
    session.inputs.send({
      t: "choice",
      kind: decision.kind,
      wave: globalScene.currentBattle.waveIndex,
      payload: decision,
    });
  };
  const stay = () => {
    answer(-1);
    apply(-1);
  };
  if (settings.general.battleStyle === BattleStyle.SET) {
    stay();
    return true;
  }
  ui.showText(i18next.t("battle:switchQuestion", { pokemonName: getPokemonNameWithAffix(pokemon) }), null, () => {
    ui.setMode(UiMode.CONFIRM, {
      yesHandler: () => {
        ui.setMode(
          UiMode.PARTY,
          PartyUiMode.POST_BATTLE_SWITCH,
          fieldIndex,
          (slotIndex: number) => {
            answer(slotIndex);
            ui.setMode(UiMode.MESSAGE).then(() => apply(slotIndex));
          },
          PartyUiHandler.FilterNonFainted,
        );
      },
      noHandler: () => {
        ui.setMode(UiMode.MESSAGE);
        stay();
      },
    });
  });
  return true;
}
