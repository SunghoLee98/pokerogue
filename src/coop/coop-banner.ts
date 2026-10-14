/**
 * A one-line notice at the top of the screen for co-op: whose turn it is to choose, or what the partner pinged.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import { addTextObject } from "#ui/text";

let banner: Phaser.GameObjects.Text | null = null;
let shown: string | null = null;

/**
 * Show `text` at the top of the screen, replacing what the banner showed before.
 * @param onRewardScreen - At the very top, above the reward screen's shop row; otherwise below the held item bar
 * @param aboveScreens - In front of the other screens, for notices that must not be missed (a lost connection),
 *   even on screens that cover the battle such as the starter selection; otherwise behind them
 */
export function showCoopBanner(text: string, onRewardScreen = false, aboveScreens = false): void {
  if (banner?.scene !== globalScene) {
    // Small, in the top left corner: clear of the shop row and the wave and money at the top right.
    banner = addTextObject(3, -globalScene.scaledCanvas.height + 2, "", TextStyle.PARTY);
    banner.setName("coop-banner");
    globalScene.ui.add(banner);
  }
  banner.setY(-globalScene.scaledCanvas.height + (onRewardScreen ? 2 : 20));
  banner.setText(text).setVisible(true);
  if (aboveScreens) {
    globalScene.ui.bringToTop(banner);
  } else {
    // Behind the other screens (the party screen opened from the reward screen covers it).
    globalScene.ui.sendToBack(banner);
  }
  shown = text;
}

export function hideCoopBanner(): void {
  banner?.setVisible(false);
  shown = null;
}

/** The text the banner shows, `null` when it is hidden. */
export function getCoopBannerText(): string | null {
  return shown;
}
