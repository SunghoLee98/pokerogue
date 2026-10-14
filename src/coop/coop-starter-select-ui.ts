/**
 * Co-op on the starter select screen: pressing start makes the player ready instead of starting the run,
 * cancel takes the ready back, and the partner's confirmed picks are shown beside the player's own.
 * Both players share the solo starter point budget, so the player's limit is what the partner's ready picks left.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { speciesDataRegistry } from "#app/global-species-data-registry";
import { coopLobby } from "#coop/coop-lobby";
import type { CoopStarterPayload } from "#coop/coop-protocol";
import { buildStarterPayload } from "#coop/coop-starter-payload";
import type { CoopStarterPoints, CoopStarterSelection } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import type { Unsubscribe } from "#coop/coop-transport";
import { Gender } from "#data/gender";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import type { Starter } from "#types/save-data";
import type { StarterSpeciesId } from "#types/starter-species-id";
import { getPartyValue, getRunValueLimit } from "#ui/starter-select-ui-utils";
import { addTextObject } from "#ui/text";

/** Where the partner's picks and the co-op status are drawn. */
export interface CoopPartnerView {
  /** Show the partner's confirmed picks (empty while they are still picking). */
  setPartner(picks: readonly CoopStarterPayload[], ready: boolean): void;
  setStatus(text: string): void;
  destroy(): void;
}

export interface CoopStarterSelectOptions {
  /** Turns a local starter into a payload. Default: {@linkcode buildStarterPayload} */
  buildPayload?(starter: Starter): CoopStarterPayload;
  /** The starter point budget both players share. Default: the solo limit, {@linkcode getRunValueLimit} */
  getSharedLimit?(): number;
  /** What the starters cost on the local account. Default: {@linkcode getPartyValue} */
  getCost?(starters: readonly Starter[]): number;
  /** Called when the partner's ready changes the local player's point limit */
  onLimitChange?(): void;
}

export class CoopStarterSelectController {
  private readonly selection: CoopStarterSelection;
  private readonly view: CoopPartnerView;
  private readonly buildPayload: (starter: Starter) => CoopStarterPayload;
  private readonly getSharedLimit: () => number;
  private readonly getCost: (starters: readonly Starter[]) => number;
  private readonly onLimitChange: () => void;
  private readonly unsubscribes: Unsubscribe[];
  /** The starters of the last ready, handed to the start callback */
  private confirmedStarters: Starter[] = [];
  /** The partner's cost when {@linkcode onLimitChange} last ran */
  private lastPartnerCost = 0;
  /** Whether the last confirm was refused because the starters cost more than the points left */
  private overLimit = false;

  /**
   * @param onStart - Called once when the run starts, with the local player's starters
   */
  constructor(
    selection: CoopStarterSelection,
    view: CoopPartnerView,
    onStart: (starters: Starter[]) => void,
    options: CoopStarterSelectOptions = {},
  ) {
    this.selection = selection;
    this.view = view;
    this.buildPayload = options.buildPayload ?? (starter => buildStarterPayload(starter));
    this.getSharedLimit = options.getSharedLimit ?? getRunValueLimit;
    this.getCost =
      options.getCost ?? (starters => getPartyValue(starters.map(starter => starter.speciesId as StarterSpeciesId)));
    this.onLimitChange = options.onLimitChange ?? (() => {});
    this.unsubscribes = [
      selection.onChange(() => this.render()),
      selection.onStart(() => onStart(this.confirmedStarters)),
    ];
    this.render();
  }

  /** The local player's starter point limit: what the partner's ready picks left of the shared budget. */
  get valueLimit(): number {
    return this.getSharedLimit() - this.selection.partner.cost;
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
    const points: CoopStarterPoints = { cost: this.getCost(starters), limit: this.getSharedLimit() };
    this.overLimit = points.cost > this.valueLimit;
    if (!this.overLimit) {
      this.confirmedStarters = [...starters];
      this.selection.setReady(
        starters.map(starter => this.buildPayload(starter)),
        points,
      );
    }
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
    const limitChanged = partner.cost !== this.lastPartnerCost;
    if (limitChanged) {
      this.lastPartnerCost = partner.cost;
      this.overLimit = false;
    }
    this.view.setPartner(partner.picks, partner.ready);
    if (this.selection.closed) {
      this.view.setStatus(coopText("partnerLeft"));
    } else if (this.selection.localReady) {
      this.overLimit = false;
      this.view.setStatus(coopText("waitingForReady"));
    } else if (partner.ready && (this.selection.readyYielded || this.overLimit)) {
      this.view.setStatus(coopText("notEnoughPoints"));
    } else {
      this.view.setStatus(coopText(partner.ready ? "partnerReady" : "partnerPicking"));
    }
    if (limitChanged) {
      this.onLimitChange();
    }
  }
}

/** Positions on the starter select screen, supplied by its handler. */
export interface CoopStarterSelectLayout {
  /** Position of team slot `index` (0-5); the partner's picks use the slots after the player's own */
  iconPosition(index: number): [x: number, y: number];
  /** The screen's own team slot icons (0-5); the free ones show the empty-slot placeholder */
  slotIcons: readonly Phaser.GameObjects.Sprite[];
  /** Right edge and top of the status text */
  statusPosition: [x: number, y: number];
  /** The co-op objects are drawn just below this child of the container, so the screen's later layers cover them */
  drawBelow: Phaser.GameObjects.GameObject;
}

/** Draws the partner's picks as icons in the free team slots and the status as text. */
class PhaserCoopPartnerView implements CoopPartnerView {
  private readonly icons: Phaser.GameObjects.Sprite[];
  /** The placeholders under {@linkcode icons}, hidden while a partner pick covers them */
  private readonly placeholders: Phaser.GameObjects.Sprite[];
  private readonly status: Phaser.GameObjects.Text;

  constructor(container: Phaser.GameObjects.Container, layout: CoopStarterSelectLayout, firstSlot: number) {
    this.icons = [];
    this.placeholders = layout.slotIcons.slice(firstSlot, firstSlot + 3);
    for (let i = 0; i < 3; i++) {
      const [x, y] = layout.iconPosition(firstSlot + i);
      this.icons.push(globalScene.add.sprite(x, y, "pokemon_icons_0").setScale(0.5).setOrigin(0).setVisible(false));
    }
    const [x, y] = layout.statusPosition;
    this.status = addTextObject(x, y, "", TextStyle.TOOLTIP_CONTENT, { fontSize: "42px" }).setOrigin(1, 0);
    container.addAt([...this.icons, this.status], container.getIndex(layout.drawBelow));
  }

  setPartner(picks: readonly CoopStarterPayload[]): void {
    for (const [i, icon] of this.icons.entries()) {
      const pick = picks.at(i);
      this.placeholders.at(i)?.setVisible(!pick);
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
    for (const placeholder of this.placeholders) {
      placeholder.setVisible(true);
    }
    this.status.destroy();
  }
}

/**
 * Set up co-op on the starter select screen, if the player is in a co-op lobby.
 * @param onStart - Called when the run starts, with the local player's starters
 * @param onLimitChange - Called when the partner's ready changes the player's starter point limit
 * @returns The controller, or `null` outside co-op
 */
export function createCoopStarterSelectUi(
  container: Phaser.GameObjects.Container,
  layout: CoopStarterSelectLayout,
  onStart: (starters: Starter[]) => void,
  onLimitChange: () => void = () => {},
): CoopStarterSelectController | null {
  if (!coopLobby) {
    return null;
  }
  const view = new PhaserCoopPartnerView(container, layout, 3);
  return new CoopStarterSelectController(coopLobby.selection, view, onStart, { onLimitChange });
}
