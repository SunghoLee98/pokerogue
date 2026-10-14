import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { MockInputText } from "#test/mocks/mocks-container/mock-input-text";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/** Stub `matchMedia` so touch-screen media queries (`(hover: none)`, `(pointer: coarse)`) match or not. */
function stubTouchScreen(touch: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: touch && /hover: none|pointer: coarse/.test(query) }));
}

describe("login form focus", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(async () => {
    game = new GameManager(phaserGame);
    await game.scene.ui.setMode(UiMode.MESSAGE);
    // The headless test game has no input manager, but the login form sets the canvas cursor style.
    game.scene.input.manager ??= { canvas: { style: {} } } as unknown as Phaser.Input.InputManager;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function openLoginForm(): Promise<ReturnType<typeof vi.spyOn>> {
    const setFocus = vi.spyOn(MockInputText.prototype, "setFocus");
    await game.scene.ui.setMode(UiMode.LOGIN_FORM, { buttonActions: [() => {}, () => {}] });
    await vi.advanceTimersByTimeAsync(100);
    return setFocus;
  }

  it("focuses the username field when the form opens with a mouse", async () => {
    stubTouchScreen(false);
    const setFocus = await openLoginForm();
    expect(setFocus).toHaveBeenCalled();
  });

  // Mobile browsers (iOS Safari in particular) only show the caret and keyboard for a focus the player
  // tapped; a focus from a timer leaves the field focused but untypeable, and tapping it then changes nothing.
  it("leaves the fields for the player to tap on a touch screen", async () => {
    stubTouchScreen(true);
    const setFocus = await openLoginForm();
    expect(setFocus).not.toHaveBeenCalled();
  });
});
