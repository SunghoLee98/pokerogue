/**
 * The co-op tab of the run history screen (spec 3.7, 4.4 "협동 기록").
 *
 * Run history stays in each client's local storage, as in solo. Co-op runs are marked with their `coop` block and are
 * shown only in the co-op tab; the solo tab, shown first, leaves them out. Left and right switch tabs.
 * @module
 */

import { globalScene } from "#app/global-scene";
import type { CoopRole } from "#coop/coop-protocol";
import { coopText } from "#coop/coop-text";
import { Button } from "#enums/buttons";
import { TextStyle } from "#enums/text-style";
import type { GameData } from "#system/game-data";
import type { RunEntry, RunHistoryData } from "#types/save-data";
import type { RunHistoryUiHandler } from "#ui/run-history-ui-handler";
import { addTextObject } from "#ui/text";

let coopTab = false;
let tabLabel: Phaser.GameObjects.Text | null = null;

/** Whether a run history entry is a co-op run. */
export function isCoopRunEntry(run: RunEntry): boolean {
  return run.entry.coop != null;
}

/** The runs of the open tab. */
export function filterCoopRunHistory(runs: RunHistoryData): RunHistoryData {
  return Object.fromEntries(Object.entries(runs).filter(([, run]) => isCoopRunEntry(run) === coopTab));
}

/**
 * The run history screen opens: start on the solo tab and show the tab's name at the top right.
 * @param container - The screen's container
 */
export function showCoopRunHistoryTab(container: Phaser.GameObjects.Container): void {
  coopTab = false;
  if (tabLabel?.scene !== globalScene || tabLabel.parentContainer !== container) {
    tabLabel = addTextObject(
      globalScene.scaledCanvas.width - 12,
      -globalScene.scaledCanvas.height + 9,
      "",
      TextStyle.WINDOW,
      {
        fontSize: "48px",
      },
    );
    tabLabel.setOrigin(1, 0);
    tabLabel.setName("coop-run-history-tab");
    container.add(tabLabel);
  }
  updateTabLabel(container);
}

function updateTabLabel(container: Phaser.GameObjects.Container): void {
  tabLabel?.setText(coopText(coopTab ? "runHistoryCoopTab" : "runHistorySoloTab"));
  if (tabLabel) {
    container.bringToTop(tabLabel);
  }
}

/**
 * Left and right switch between the solo and co-op tabs, and show the runs of the new tab.
 * @returns Whether the button switched tabs
 */
export function switchCoopRunHistoryTab(button: Button, handler: RunHistoryUiHandler): boolean {
  if (button !== Button.LEFT && button !== Button.RIGHT) {
    return false;
  }
  coopTab = !coopTab;
  updateTabLabel(handler["runSelectContainer"]);
  // As the screen does when it opens.
  handler["clearCursor"]();
  handler["clearRuns"]();
  handler["setScrollCursor"](0);
  handler["populateRuns"]().then(() => {
    handler.setCursor(0);
    if (handler["runs"].length === 0) {
      handler["clearCursor"]();
    }
  });
  globalScene.ui.playSelect();
  return true;
}

/**
 * The game mode line of a run: for a co-op run, "Co-op: partner" in place of the game mode.
 * @param mode - The game mode name the line shows otherwise
 */
export function getCoopRunModeLabel(run: RunEntry, mode: string): string {
  const coop = run.entry.coop;
  if (!coop) {
    return mode;
  }
  const partnerRole: CoopRole = coop.localRole === "guest" ? "host" : "guest";
  // Room for the wave number before the party icons.
  const partner = (coop.participants?.[partnerRole] ?? "").slice(0, 8);
  return coopText("runHistoryCoopMode", { partner });
}

/** The co-op rows of the game stats screen, after the daily run rows. */
export const coopDisplayStats = {
  coopSessionsPlayed: {
    label: () => coopText("statCoopRuns"),
    sourceFunc: (gameData: GameData) => gameData.gameStats.coopSessionsPlayed.toString(),
  },
  coopSessionsWon: {
    label: () => coopText("statCoopWins"),
    sourceFunc: (gameData: GameData) => gameData.gameStats.coopSessionsWon.toString(),
  },
};
