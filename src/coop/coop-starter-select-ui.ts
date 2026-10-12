/**
 * Co-op on the starter select screen: pressing start makes the player ready instead of starting the run,
 * cancel takes the ready back, and the partner's confirmed picks are shown beside the player's own.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { coopLobby } from "#coop/coop-lobby";
import type { CoopStarterPayload } from "#coop/coop-protocol";
import { buildStarterPayload } from "#coop/coop-starter-payload";
import type { CoopStarterSelection } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import type { Unsubscribe } from "#coop/coop-transport";
import { Gender } from "#data/gender";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import type { Starter } from "#types/save-data";
import { addTextObject } from "#ui/text";

/** Where the partner's picks and the co-op status are drawn. */
export interface CoopPartnerView {
  /** Show the partner's confirmed picks (empty while they are still picking). */
  setPartner(picks: readonly CoopStarterPayload[], ready: boolean): void;
  setStatus(text: string): void;
  destroy(): void;
}

export class CoopStarterSelectController {
  private readonly selection: CoopStarterSelection;
  private readonly view: CoopPartnerView;
  private readonly buildPayload: (starter: Starter) => CoopStarterPayload;
  private readonly unsubscribes: Unsubscribe[];
  /** The starters of the last ready, handed to the start callback */
  private confirmedStarters: Starter[] = [];

  /**
   * @param onStart - Called once when the run starts, with the local player's starters
   * @param buildPayload - Turns a local starter into a payload; default {@linkcode buildStarterPayload}
   */
  constructor(
    selection: CoopStarterSelection,
    view: CoopPartnerView,
    onStart: (starters: Starter[]) => void,
    buildPayload: (starter: Starter) => CoopStarterPayload = starter => buildStarterPayload(starter),
  ) {
    this.selection = selection;
    this.view = view;
    this.buildPayload = buildPayload;
    this.unsubscribes = [
      selection.onChange(() => this.render()),
      selection.onStart(() => onStart(this.confirmedStarters)),
    ];
    this.render();
  }

  /**
   * The player confirmed their team: become ready and wait for the partner.
   * @returns `true`, since in co-op confirming never starts the run directly
   */
  confirm(starters: Starter[]): boolean {
    if (this.selection.closed) {
      this.render();
      return true;
    }
    this.confirmedStarters = [...starters];
    this.selection.setReady(starters.map(starter => this.buildPayload(starter)));
    this.render();
    return true;
  }

  /**
   * Handle input before the starter select screen does.
   * @returns Whether the input was consumed: while ready (cancel takes the ready back) or once the run started
   */
  processInput(button: Button): boolean {
    if (this.selection.startInfo) {
      return true;
    }
    if (!this.selection.localReady) {
      return false;
    }
    if (button === Button.CANCEL) {
      this.selection.cancelReady();
      this.render();
    }
    return true;
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.view.destroy();
  }

  private render(): void {
    const { partner } = this.selection;
    this.view.setPartner(partner.picks, partner.ready);
    if (this.selection.closed) {
      this.view.setStatus(coopText("partnerLeft"));
    } else if (this.selection.localReady) {
      this.view.setStatus(coopText("waitingForReady"));
    } else {
      this.view.setStatus(coopText(partner.ready ? "partnerReady" : "partnerPicking"));
    }
  }
}

/** Positions on the starter select screen, supplied by its handler. */
export interface CoopStarterSelectLayout {
  /** Position of team slot `index` (0-5); the partner's picks use the slots after the player's own */
  iconPosition(index: number): [x: number, y: number];
  statusPosition: [x: number, y: number];
}

/** Draws the partner's picks as icons in the free team slots and the status as text. */
class PhaserCoopPartnerView implements CoopPartnerView {
  private readonly icons: Phaser.GameObjects.Sprite[];
  private readonly status: Phaser.GameObjects.Text;

  constructor(container: Phaser.GameObjects.Container, layout: CoopStarterSelectLayout, firstSlot: number) {
    this.icons = [];
    for (let i = 0; i < 3; i++) {
      const [x, y] = layout.iconPosition(firstSlot + i);
      this.icons.push(globalScene.add.sprite(x, y, "pokemon_icons_0").setScale(0.5).setOrigin(0).setVisible(false));
    }
    const [x, y] = layout.statusPosition;
    this.status = addTextObject(x, y, "", TextStyle.TOOLTIP_CONTENT, { fontSize: "42px" }).setOrigin(1, 0);
    container.add([...this.icons, this.status]);
  }

  setPartner(picks: readonly CoopStarterPayload[]): void {
    for (const [i, icon] of this.icons.entries()) {
      const pick = picks.at(i);
      if (!pick) {
        icon.setVisible(false);
        continue;
      }
      const species = speciesDataRegistry.getSpecies(pick.speciesId);
      const female = pick.gender === Gender.FEMALE;
      icon
        .setTexture(species.getIconAtlasKey(pick.formIndex, pick.shiny, pick.variant))
        .setFrame(species.getIconId(female, pick.formIndex, pick.shiny, pick.variant))
        .setVisible(true);
    }
  }

  setStatus(text: string): void {
    this.status.setText(text);
  }

  destroy(): void {
    for (const icon of this.icons) {
      icon.destroy();
    }
    this.status.destroy();
  }
}

/**
 * Set up co-op on the starter select screen, if the player is in a co-op lobby.
 * @param onStart - Called when the run starts, with the local player's starters
 * @returns The controller, or `null` outside co-op
 */
export function createCoopStarterSelectUi(
  container: Phaser.GameObjects.Container,
  layout: CoopStarterSelectLayout,
  onStart: (starters: Starter[]) => void,
): CoopStarterSelectController | null {
  if (!coopLobby) {
    return null;
  }
  const view = new PhaserCoopPartnerView(container, layout, 3);
  return new CoopStarterSelectController(coopLobby.selection, view, onStart);
}
