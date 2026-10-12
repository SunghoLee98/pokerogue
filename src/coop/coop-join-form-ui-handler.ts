/**
 * The form where the guest types the host's join code.
 * @module
 */

import { coopText } from "#coop/coop-text";
import type { ModalConfig } from "#types/ui-types";
import { FormModalUiHandler, type InputFieldConfig } from "#ui/form-modal-ui-handler";
import i18next from "i18next";

export class CoopJoinFormUiHandler extends FormModalUiHandler {
  getModalTitle(_config?: ModalConfig): string {
    return coopText("joinTitle");
  }

  getWidth(_config?: ModalConfig): number {
    return 160;
  }

  getMargin(_config?: ModalConfig): [number, number, number, number] {
    return [0, 0, 48, 0];
  }

  getButtonLabels(_config?: ModalConfig): string[] {
    return [coopText("joinGame"), i18next.t("menu:cancel")];
  }

  override getInputFieldConfigs(): InputFieldConfig[] {
    return [{ label: coopText("joinCodeLabel") }];
  }

  /** @param args - `[config]`, where `config.buttonActions` is `[join(input: string), cancel()]` */
  override show(args: any[]): boolean {
    if (!super.show(args)) {
      return false;
    }
    for (const input of this.inputs) {
      input.text = "";
    }
    const config = args[0] as ModalConfig;
    this.submitAction = () => {
      this.sanitizeInputs();
      config.buttonActions[0](this.inputs[0].text);
    };
    return true;
  }
}
