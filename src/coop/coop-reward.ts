/**
 * The reward screen in co-op (spec 3.5).
 *
 * One player picks the wave's free reward (the host on odd waves, the guest on even waves); both may buy from the
 * shop, which uses the shared wallet. Nothing done on the screen changes the run right away. Each action becomes a
 * reward event; the host numbers the events in the order it takes them (its own included) and both clients apply them
 * in that order only. Checks that depend on the order (is there still money for this, is the screen still open) are
 * made when an event is applied, so both clients reach the same verdict without further messages.
 *
 * Screens are counted in the order both clients open them (`gen`): a reroll or a TM's copy of the screen is a new
 * screen. An event for a screen that has closed is dropped.
 * @module
 */

import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import { activeOverrides } from "#app/overrides";
import { hideCoopBanner, showCoopBanner } from "#coop/coop-banner";
import type { CoopRewardMessage } from "#coop/coop-input-broker";
import { listenForCoopPings, sendCoopPing } from "#coop/coop-ping";
import type { CoopRewardAction } from "#coop/coop-protocol";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { coopText } from "#coop/coop-text";
import { UiMode } from "#enums/ui-mode";
import { HealShopCostModifier, type Modifier, PokemonHeldItemModifier } from "#modifiers/modifier";
import {
  FusePokemonModifierType,
  getPlayerShopModifierTypeOptionsForWave,
  type ModifierType,
  type ModifierTypeOption,
  PokemonModifierType,
  PokemonMoveModifierType,
  RememberMoveModifierType,
} from "#modifiers/modifier-type";
import type { ModifierSelectCallback, SelectModifierPhase } from "#phases/select-modifier-phase";
import { type ModifierSelectUiHandler, SHOP_OPTIONS_ROW_LIMIT } from "#ui/modifier-select-ui-handler";
import { PartyOption } from "#ui/party-ui-handler";
import { NumberHolder } from "#utils/common";

/** Lures raise the chance of double battles, which co-op always has: they are left out of the rewards (spec 3.5). */
export function coopExcludesLures(): boolean {
  return coopSession !== null;
}

/** The target picked in the party screen for a reward or a purchase. */
export interface CoopRewardTarget {
  slot: number;
  partyOption?: number;
  splice?: number;
}

/** One opened reward screen. */
interface RewardScreen {
  phase: SelectModifierPhase;
  gen: number;
  /** The reward or shop item the local player is choosing a target for */
  pending: Extract<CoopRewardAction, { kind: "reward" | "shop" }> | null;
  /** The screen's input callback as the UI holds it */
  callback: ModifierSelectCallback | null;
}

interface RewardState {
  session: CoopSession;
  /** The newest screen's number, `-1` before the first */
  gen: number;
  screen: RewardScreen | null;
  /** Numbered events not applied yet, in `seq` order */
  queue: CoopRewardMessage[];
  nextApply: number;
  /** Host only: the next number to give */
  nextSeq: number;
  nextReq: number;
  busy: boolean;
}

const states = new WeakMap<CoopSession, RewardState>();

function getState(session: CoopSession): RewardState {
  let state = states.get(session);
  if (!state) {
    const created: RewardState = {
      session,
      gen: -1,
      screen: null,
      queue: [],
      nextApply: 0,
      nextSeq: 0,
      nextReq: 0,
      busy: false,
    };
    states.set(session, created);
    session.inputs.onReward(message => receive(created, message));
    state = created;
  }
  return state;
}

function phaseField<T>(phase: SelectModifierPhase, name: string): T {
  return (phase as unknown as Record<string, T>)[name];
}

function getHandler(): ModifierSelectUiHandler {
  return globalScene.ui.handlers[UiMode.MODIFIER_SELECT] as ModifierSelectUiHandler;
}

function isPicker(session: CoopSession): boolean {
  return session.isLocalPicker(globalScene.currentBattle.waveIndex);
}

/**
 * A reward screen opens (`SelectModifierPhase.start`, once its options exist).
 * Both clients open the same screens in the same order, so both count the same `gen`.
 */
export function openCoopRewardScreen(phase: SelectModifierPhase): void {
  const session = coopSession;
  if (!session) {
    return;
  }
  listenForCoopPings(session);
  const state = getState(session);
  state.gen++;
  state.screen = { phase, gen: state.gen, pending: null, callback: null };
  if (isPicker(session)) {
    hideCoopBanner();
  } else {
    showCoopBanner(coopText("partnerPickingReward"));
  }
  pump(state);
}

/** The number of the newest reward screen opened in this session, `-1` before the first. */
export function getCoopRewardGen(): number {
  return coopSession ? (states.get(coopSession)?.gen ?? -1) : -1;
}

/** The offered free rewards of the open co-op reward screen (type ids), empty if none is open. */
export function getCoopRewardOptionIds(): string[] {
  const screen = coopSession ? states.get(coopSession)?.screen : null;
  if (!screen || !isScreenOpen(screen)) {
    return [];
  }
  return phaseField<ModifierTypeOption[]>(screen.phase, "typeOptions").map(o => o.type.id);
}

function isScreenOpen(screen: RewardScreen): boolean {
  return globalScene.phaseManager.getCurrentPhase() === screen.phase;
}

function getScreen(phase: SelectModifierPhase): RewardScreen | null {
  const screen = coopSession ? states.get(coopSession)?.screen : null;
  return screen?.phase === phase ? screen : null;
}

/** Let the reward screen take input again with the callback it had. */
function restoreInput(screen: RewardScreen): void {
  const handler = getHandler() as unknown as { awaitingActionInput: boolean; onActionInput: ModifierSelectCallback };
  if (screen.callback && globalScene.ui.mode === UiMode.MODIFIER_SELECT) {
    handler.awaitingActionInput = true;
    handler.onActionInput = screen.callback;
  }
}

/** The index of a shop item in the wave's shop list, as `SelectModifierPhase` finds it. */
function getShopIndex(rowCursor: number, cursor: number): number {
  const shopCount = getPlayerShopModifierTypeOptionsForWave(
    globalScene.currentBattle.waveIndex,
    globalScene.getWaveMoneyAmount(1),
  ).length;
  return rowCursor > 2 || shopCount <= SHOP_OPTIONS_ROW_LIMIT ? cursor : cursor + SHOP_OPTIONS_ROW_LIMIT;
}

/**
 * Wrap the reward screen's input callback.
 * - The free reward row, reroll, lock and item transfer belong to the picker; the other player's presses ping instead.
 * - Reroll and lock are sent as events. Picking a reward or a shop item goes through the usual screens; the final
 *   choice is sent by {@linkcode submitCoopRewardChoice}.
 * @returns The callback itself outside co-op
 */
export function wrapCoopModifierSelect(
  phase: SelectModifierPhase,
  callback: ModifierSelectCallback,
): ModifierSelectCallback {
  const session = coopSession;
  const screen = getScreen(phase);
  if (!session || !screen) {
    return callback;
  }
  const wrapped: ModifierSelectCallback = (rowCursor, cursor) => {
    screen.pending = null;
    const picker = isPicker(session);
    if (rowCursor < 0 || cursor < 0) {
      if (picker) {
        return callback(rowCursor, cursor);
      }
      restoreInput(screen);
      return false;
    }
    if (rowCursor === 0) {
      return handleButtonRow(session, screen, picker, cursor, callback);
    }
    if (rowCursor === 1) {
      if (!picker) {
        sendCoopPing("reward", { row: rowCursor, cursor });
        return false;
      }
      screen.pending = { kind: "reward", option: cursor };
      return callback(rowCursor, cursor);
    }
    screen.pending = { kind: "shop", option: getShopIndex(rowCursor, cursor) };
    return callback(rowCursor, cursor);
  };
  screen.callback = wrapped;
  return wrapped;
}

/** Reroll, transfer, check team and lock (in cursor order). */
function handleButtonRow(
  session: CoopSession,
  screen: RewardScreen,
  picker: boolean,
  cursor: number,
  callback: ModifierSelectCallback,
): boolean {
  const ui = globalScene.ui;
  switch (cursor) {
    case 0: {
      if (!picker) {
        sendCoopPing("reward", { row: 0, cursor });
        return false;
      }
      const cost = screen.phase.getRerollCost(globalScene.lockModifierTiers);
      if (cost < 0 || globalScene.money < cost) {
        ui.playError();
        return false;
      }
      submit(session, screen, { kind: "reroll" });
      return true;
    }
    case 1:
    case 3:
      if (!picker) {
        ui.playError();
        return false;
      }
      if (cursor === 3 && screen.phase.getRerollCost(globalScene.lockModifierTiers) >= 0) {
        submit(session, screen, { kind: "lock" });
        return false;
      }
      return callback(0, cursor);
    default:
      return callback(0, cursor);
  }
}

/**
 * The local player confirmed a reward or a shop item (with its target, if it has one).
 * In co-op it is sent as an event instead of being applied.
 * @returns Whether co-op took it (the caller must not apply it)
 */
export function submitCoopRewardChoice(phase: SelectModifierPhase, target?: CoopRewardTarget): boolean {
  const session = coopSession;
  const screen = getScreen(phase);
  if (!session || !screen?.pending) {
    return false;
  }
  const action = { ...screen.pending, ...target };
  screen.pending = null;
  if (target) {
    // Back from the party screen to the reward screen first, as the solo flow does before applying: applying may
    // close the screen, which must not race the transition back.
    globalScene.ui.setMode(UiMode.MODIFIER_SELECT, phase.isPlayer()).then(() => submit(session, screen, action));
  } else {
    submit(session, screen, action);
  }
  return true;
}

/**
 * The local player did something on the reward screen that changes the run (transfer an item, skip the reward).
 * @returns Whether co-op took it (the caller must not do it)
 */
export function submitCoopRewardAction(phase: SelectModifierPhase, action: CoopRewardAction): boolean {
  const session = coopSession;
  const screen = getScreen(phase);
  if (!session || !screen) {
    return false;
  }
  submit(session, screen, action);
  return true;
}

function submit(session: CoopSession, screen: RewardScreen, action: CoopRewardAction): void {
  const state = getState(session);
  const message: CoopRewardMessage = {
    t: "reward",
    wave: globalScene.currentBattle.waveIndex,
    gen: screen.gen,
    req: state.nextReq++,
    by: session.localRole,
    action,
  };
  if (session.localRole === "host") {
    order(state, message);
  } else {
    session.inputs.send(message);
  }
}

/** Host: give the event the next number, tell the guest and queue it. */
function order(state: RewardState, message: CoopRewardMessage): void {
  const numbered = { ...message, seq: state.nextSeq++ };
  state.session.inputs.send(numbered);
  enqueue(state, numbered);
}

function receive(state: RewardState, message: CoopRewardMessage): void {
  if (coopSession !== state.session) {
    return;
  }
  if (message.seq === undefined) {
    if (state.session.localRole === "host") {
      order(state, message);
    }
    return;
  }
  enqueue(state, message);
}

function enqueue(state: RewardState, message: CoopRewardMessage): void {
  state.queue.push(message);
  state.queue.sort((a, b) => a.seq! - b.seq!);
  pump(state);
}

/**
 * Take the next event to apply on the open screen, dropping those for screens that have closed.
 * @returns `null` when the next event has not arrived or its screen is not open yet
 */
function takeNext(state: RewardState, screen: RewardScreen): CoopRewardMessage | null {
  while (state.queue[0]?.seq === state.nextApply && state.queue[0].gen <= screen.gen) {
    const event = state.queue.shift()!;
    state.nextApply++;
    if (event.gen === screen.gen && event.wave === globalScene.currentBattle.waveIndex) {
      return event;
    }
    // The screen it was meant for has closed.
    if (event.by === state.session.localRole) {
      globalScene.ui.playError();
    }
  }
  return null;
}

/** Apply the queued events in order while a screen is open for them. */
function pump(state: RewardState): void {
  while (!state.busy && state.screen && isScreenOpen(state.screen)) {
    const screen = state.screen;
    const event = takeNext(state, screen);
    if (!event) {
      return;
    }
    state.busy = true;
    const keepsScreen = apply(state.session, screen, event);
    state.busy = false;
    if (keepsScreen && event.by === state.session.localRole) {
      restoreInput(screen);
    }
  }
}

/**
 * Apply one event on this client, the same way on both.
 * @returns Whether the screen stays open
 */
function apply(session: CoopSession, screen: RewardScreen, event: CoopRewardMessage): boolean {
  const { phase } = screen;
  const local = event.by === session.localRole;
  const { action } = event;
  switch (action.kind) {
    case "reward":
      applyReward(phase, action);
      return false;
    case "shop":
      return applyPurchase(phase, action, local);
    case "reroll":
      return !phaseField<() => boolean>(phase, "rerollModifiers").call(phase);
    case "lock":
      applyLock(phase);
      return true;
    case "transfer":
      applyTransfer(action);
      return true;
    case "skip":
      closeScreen(phase);
      return false;
  }
}

function closeScreen(phase: SelectModifierPhase): void {
  hideCoopBanner();
  globalScene.ui.clearText();
  globalScene.ui.setMode(UiMode.MESSAGE);
  phase.end();
}

/** Make the modifier the solo screens would make for this target. */
function createModifier(
  type: ModifierType,
  action: Extract<CoopRewardAction, { kind: "reward" | "shop" }>,
): Modifier | null {
  if (!(type instanceof PokemonModifierType) || action.slot === undefined) {
    return type.newModifier();
  }
  const party = globalScene.getPlayerParty();
  const pokemon = party[action.slot];
  if (type instanceof FusePokemonModifierType) {
    return type.newModifier(pokemon, party["splice" in action ? (action.splice ?? -1) : -1]);
  }
  if (type instanceof PokemonMoveModifierType) {
    return type.newModifier(pokemon, (action.partyOption ?? PartyOption.MOVE_1) - PartyOption.MOVE_1);
  }
  if (type instanceof RememberMoveModifierType) {
    return type.newModifier(pokemon, action.partyOption);
  }
  return type.newModifier(pokemon);
}

function applyReward(phase: SelectModifierPhase, action: Extract<CoopRewardAction, { kind: "reward" }>): void {
  const option = phaseField<ModifierTypeOption[]>(phase, "typeOptions")[action.option];
  const modifier = option && createModifier(option.type, action);
  if (!modifier) {
    closeScreen(phase);
    return;
  }
  hideCoopBanner();
  phaseField<(modifier: Modifier, cost: number, playSound: boolean) => void>(phase, "applyModifier").call(
    phase,
    modifier,
    -1,
    action.slot !== undefined,
  );
}

/** @returns Whether the screen stays open */
function applyPurchase(
  phase: SelectModifierPhase,
  action: Extract<CoopRewardAction, { kind: "shop" }>,
  local: boolean,
): boolean {
  const option = getPlayerShopModifierTypeOptionsForWave(
    globalScene.currentBattle.waveIndex,
    globalScene.getWaveMoneyAmount(1),
  )[action.option];
  if (!option) {
    return true;
  }
  const cost = new NumberHolder(option.cost);
  globalScene.applyModifier(HealShopCostModifier, true, cost);
  const waived = activeOverrides.WAIVE_ROLL_FEE_OVERRIDE;
  if (globalScene.money < cost.value && !waived) {
    if (local) {
      globalScene.ui.playError();
      globalScene.ui.showText(coopText("notEnoughMoney"), null, null, null, true);
    }
    return true;
  }
  const modifier = createModifier(option.type, action);
  if (!modifier) {
    return true;
  }
  if (option.type instanceof RememberMoveModifierType) {
    // Closes the screen and reopens a copy after the move is learned, as in solo.
    hideCoopBanner();
    phaseField<(modifier: Modifier, cost: number, playSound: boolean) => void>(phase, "applyModifier").call(
      phase,
      modifier,
      cost.value,
      true,
    );
    return false;
  }
  // As `SelectModifierPhase.applyModifier` does for a purchase, without assuming the reward screen is shown:
  // the other player may be in the party screen.
  if (globalScene.addModifier(modifier, false, true, undefined, undefined, cost.value)) {
    if (!waived) {
      globalScene.money -= cost.value;
      globalScene.updateMoneyText();
      globalScene.animateMoneyChanged(false);
    }
    audioManager.playSound("se/buy");
    getHandler().updateCostText();
  } else if (local) {
    globalScene.ui.playError();
  }
  return true;
}

function applyLock(phase: SelectModifierPhase): void {
  globalScene.lockModifierTiers = !globalScene.lockModifierTiers;
  const handler = getHandler();
  handler.setRerollCost(phase.getRerollCost(globalScene.lockModifierTiers));
  handler.updateLockRaritiesText();
  handler.updateRerollCostText();
}

function applyTransfer(action: Extract<CoopRewardAction, { kind: "transfer" }>): void {
  const party = globalScene.getPlayerParty();
  const from = party[action.from];
  const to = party[action.to];
  if (!from || !to) {
    return;
  }
  const items = globalScene.findModifiers(
    m => m instanceof PokemonHeldItemModifier && m.isTransferable && m.pokemonId === from.id,
  ) as PokemonHeldItemModifier[];
  const item = items[action.itemIndex];
  if (item) {
    globalScene.tryTransferHeldItemModifier(item, to, true, action.quantity, undefined, undefined, false);
  }
}
