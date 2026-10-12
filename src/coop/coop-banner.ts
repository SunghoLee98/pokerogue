/**
 * A one-line notice at the top of the screen for co-op: whose turn it is to choose, or what the partner pinged.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import { addTextObject } from "#ui/text";

let banner: Phaser.GameObjects.Text | null = null;
let shown: string | null = null;

/** Show `text` at the top of the screen, replacing what the banner showed before. */
export function showCoopBanner(text: string): void {
  if (banner?.scene !== globalScene) {
    banner = addTextObject(4, -globalScene.scaledCanvas.height + 2, "", TextStyle.MESSAGE);
    banner.setName("coop-banner");
    globalScene.ui.add(banner);
  }
  banner.setText(text).setVisible(true);
  globalScene.ui.bringToTop(banner);
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
