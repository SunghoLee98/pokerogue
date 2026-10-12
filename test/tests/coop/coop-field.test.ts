import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { BattleStyle } from "#enums/battle-style";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { StatusEffect } from "#enums/status-effect";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import { PartyOption } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

function startInfo(host: SpeciesId[], guest: SpeciesId[]): CoopStartInfo {
  return {
    seed: "coop-field",
    accounts: { host: snapshot(1), guest: snapshot(2) },
    picks: { host: host.map(createTestStarterPayload), guest: guest.map(createTestStarterPayload) },
    timedEvent: null,
  };
}

describe("co-op field slots", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingWave(3)
      .startingLevel(100)
      .enemyLevel(2)
      .enemySpecies(SpeciesId.MAGIKARP)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH, MoveId.MEMENTO, MoveId.HYPER_VOICE]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(role: CoopRole, host: SpeciesId[], guest: SpeciesId[]): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(host, guest), transport: partner.localTransport });
    game.phaseInterceptor.clearLogs();
    return partner;
  }

  const ownerOf = (id: number) => coopSession?.ownership.get(id);
  const activeField = () => game.scene.getPlayerField().filter(p => p.isActive(true));

  /** Turn 1 on the host's client: the host waits, the guest's pokemon faints (Memento). */
  async function guestFaintsAsHost(partner: CoopTestPartner): Promise<void> {
    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.MEMENTO, BattlerIndex.ENEMY));
  }

  /** Win the wave with the host's Hyper Voice and go to the next one. */
  async function hostWinsWave(): Promise<void> {
    game.move.select(MoveId.HYPER_VOICE, BattlerIndex.PLAYER);
    await game.toEndOfTurn();
    expect(game.isVictory()).toBe(true);
    await game.toNextWave();
  }

  it("replaces a fainted pokemon only from its owner's bench", async () => {
    const partner = await start("host", [SpeciesId.BULBASAUR, SpeciesId.PIDGEY], [SpeciesId.CHARMANDER]);
    const [, guestPokemon, hostBench] = game.scene.getPlayerParty();
    await guestFaintsAsHost(partner);
    await game.toNextTurn();

    expect(guestPokemon.isFainted()).toBe(true);
    expect(game.phaseInterceptor.phaseLog).not.toContain("SwitchPhase");
    expect(hostBench.isOnField()).toBe(false);
    expect(activeField().map(p => ownerOf(p.id))).toEqual(["host"]);
  });

  it("applies the owner's choice of replacement", async () => {
    const partner = await start("host", [SpeciesId.BULBASAUR], [SpeciesId.CHARMANDER, SpeciesId.RATTATA]);
    const rattata = game.scene.getPlayerParty()[2];
    await guestFaintsAsHost(partner);
    partner.sendDecision({ kind: "switch", seq: 0, slotIndex: 2, option: PartyOption.SEND_OUT });
    await game.toNextTurn();

    expect(game.scene.getPlayerField()[1]).toBe(rattata);
    expect(rattata.isOnField()).toBe(true);
  });

  it("clears the waiting text once the owner's choice is applied", async () => {
    const partner = await start("host", [SpeciesId.BULBASAUR], [SpeciesId.CHARMANDER, SpeciesId.RATTATA]);
    const showText = vi.spyOn(game.scene.ui, "showText");
    await guestFaintsAsHost(partner);
    partner.sendDecision({ kind: "switch", seq: 0, slotIndex: 2, option: PartyOption.SEND_OUT });
    await game.toNextTurn();

    const texts = showText.mock.calls.map(call => call[0]);
    const waiting = texts.indexOf(coopText("waitingForPartnerChoice"));
    expect(waiting).toBeGreaterThan(-1);
    expect(texts[waiting + 1]).toBe("");
  });

  it("lets the owner choose the replacement and sends it", async () => {
    const partner = await start("guest", [SpeciesId.BULBASAUR], [SpeciesId.CHARMANDER, SpeciesId.RATTATA]);
    const rattata = game.scene.getPlayerParty()[2];
    partner.sendCommand(synthesizeMoveCommand(0, MoveId.SPLASH));
    game.move.select(MoveId.MEMENTO, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY);
    game.doSelectPartyPokemon(2);
    await game.toNextTurn();

    expect(game.scene.getPlayerField()[1]).toBe(rattata);
    await vi.waitUntil(() => partner.received.some(m => m.t === "choice"));
    const choice = partner.received.find(m => m.t === "choice");
    expect(choice?.t === "choice" && choice.payload).toEqual({
      kind: "switch",
      seq: 0,
      slotIndex: 2,
      option: PartyOption.SEND_OUT,
    });
  });

  it("leaves a wiped player's slot empty in the next wave", async () => {
    const partner = await start("host", [SpeciesId.BULBASAUR, SpeciesId.PIDGEY], [SpeciesId.CHARMANDER]);
    const [bulbasaur, charmander, pidgey] = game.scene.getPlayerParty();
    await guestFaintsAsHost(partner);
    await game.toNextTurn();
    await hostWinsWave();

    expect(game.scene.currentBattle.double).toBe(true);
    expect(game.scene.getPlayerParty().slice(0, 2)).toEqual([bulbasaur, charmander]);
    expect(activeField()).toEqual([bulbasaur]);
    expect(pidgey.isOnField()).toBe(false);
    expect(game.phaseInterceptor.phaseLog).not.toContain("CheckSwitchPhase");
  });

  it("brings a revived player back in the next wave", async () => {
    const partner = await start("host", [SpeciesId.BULBASAUR, SpeciesId.PIDGEY], [SpeciesId.CHARMANDER]);
    const [bulbasaur, charmander] = game.scene.getPlayerParty();
    await guestFaintsAsHost(partner);
    await game.toNextTurn();
    game.move.select(MoveId.HYPER_VOICE, BattlerIndex.PLAYER);
    await game.toEndOfTurn();
    charmander.hp = charmander.getMaxHp();
    charmander.resetStatus();
    await game.toNextWave();

    expect(activeField()).toEqual([bulbasaur, charmander]);
  });

  it("puts each player's first living pokemon in their slot", async () => {
    const partner = await start("host", [SpeciesId.BULBASAUR, SpeciesId.PIDGEY], [SpeciesId.CHARMANDER]);
    const [bulbasaur, charmander, pidgey] = game.scene.getPlayerParty();
    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.HYPER_VOICE));
    await game.toEndOfTurn();
    expect(game.isVictory()).toBe(true);
    // The host's lead faints as the wave ends, with nobody sent out in its place.
    bulbasaur.hp = 0;
    bulbasaur.doSetStatus(StatusEffect.FAINT);
    bulbasaur.leaveField();
    await game.toNextWave();

    expect(game.scene.getPlayerField()).toEqual([pidgey, charmander]);
    expect(activeField()).toEqual([pidgey, charmander]);
    expect(pidgey.isOnField()).toBe(true);
  });

  it("does not ask whether to switch at the start of a wave", async () => {
    game.settings.battleStyle(BattleStyle.SWITCH);
    const partner = await start("host", [SpeciesId.BULBASAUR, SpeciesId.PIDGEY], [SpeciesId.CHARMANDER]);
    game.move.select(MoveId.HYPER_VOICE, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeMoveCommand(1, MoveId.SPLASH));
    await game.toEndOfTurn();
    expect(game.isVictory()).toBe(true);
    await game.toNextWave();

    expect(game.phaseInterceptor.phaseLog).toContain("NextEncounterPhase");
    expect(game.phaseInterceptor.phaseLog).not.toContain("CheckSwitchPhase");
  });
});
