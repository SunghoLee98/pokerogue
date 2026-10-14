/**
 * The "save and quit" button shown while waiting for the partner (spec 3.8).
 *
 * Waiting has no time limit, so whoever waits can end the run instead: the host keeps the save made at the start of
 * the current wave and both players return to the title screen. The button sits at the top right and is pressed with
 * the menu key (or a click), twice to confirm. It is drawn on its own, not as a UI mode, so the partner's input can
 * arrive and continue the game at any time without a menu to close first.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { endCoopRun } from "#coop/coop-exit";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { TextStyle } from "#enums/text-style";
import { addTextObject } from "#ui/text";

let button: Phaser.GameObjects.Text | null = null;
let shown: string | null = null;
let armed = false;

function show(text: string): void {
  if (button?.scene !== globalScene) {
    // Top right, under the wave and money: clear of both sides' info boxes during battle.
    button = addTextObject(
      globalScene.scaledCanvas.width - 2,
      -globalScene.scaledCanvas.height + 22,
      "",
      TextStyle.PARTY,
    );
    button.setOrigin(1, 0);
    button.setName("coop-wait-button");
    button.setInteractive();
    button.on("pointerdown", () => pressCoopWaitButton());
    globalScene.ui.add(button);
  }
  button.setText(text).setVisible(true);
  globalScene.ui.bringToTop(button);
  shown = text;
}

function hide(): void {
  button?.setVisible(false);
  shown = null;
  armed = false;
}

/** Show the button whenever the session's game waits for the partner. Called when a session opens. */
export function attachCoopWaitButton(session: CoopSession): void {
  hide();
  session.inputs.onWaitingChange(waiting => {
    if (waiting) {
      show(coopText("saveAndQuitButton"));
    } else {
      hide();
    }
  });
}

/**
 * Press the button: the first press asks to confirm, the second saves and quits.
 * @returns Whether the button took the press (only while waiting for the partner)
 */
export function pressCoopWaitButton(): boolean {
  if (!coopSession?.inputs.waiting) {
    return false;
  }
  if (!armed) {
    armed = true;
    show(coopText("saveAndQuitConfirm"));
    return true;
  }
  hide();
  coopSaveAndQuit();
  return true;
}

/**
 * Save and quit a co-op run: tell the partner, keep the host's wave start save and go back to the title screen.
 * @returns Whether a co-op run was quit (`false` outside co-op)
 */
export function coopSaveAndQuit(): boolean {
  if (!coopSession) {
    return false;
  }
  endCoopRun("savingAndQuitting", "saveAndQuit");
  return true;
}

/** The button's text, `null` when it is hidden. */
export function getCoopWaitButtonText(): string | null {
  return shown;
}
