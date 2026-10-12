import { withCoopBallTarget } from "#coop/coop-ball";
import { beginCoopCaptureDecision, isCaptureRosterFull } from "#coop/coop-capture";
import { wrapCoopPartyFilter } from "#coop/coop-field";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { coopText } from "#coop/coop-text";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { PartyUiMode } from "#enums/party-ui-mode";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeBallCommand, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import type { OptionSelectUiHandler } from "#ui/option-select-ui-handler";
import { PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

/** The host has one pokemon, the guest has the most they may own. */
const startInfo = (): CoopStartInfo => ({
  seed: "coop-capture",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [SpeciesId.CHARMANDER, SpeciesId.PIDGEY, SpeciesId.RATTATA].map(createTestStarterPayload),
  },
  timedEvent: null,
});

describe("co-op captures", () => {
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
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(role: CoopRole, info = startInfo()): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: info, transport: partner.localTransport });
    game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 5;
    return partner;
  }

  const ownerOf = (id: number) => coopSession?.ownership.get(id);
  const partyIds = () => game.scene.getPlayerParty().map(p => p.id);

  it("gives the caught pokemon to the thrower", async () => {
    const twoEach: CoopStartInfo = {
      ...startInfo(),
      picks: { host: startInfo().picks.host, guest: startInfo().picks.guest.slice(0, 1) },
    };
    const partner = await start("host", twoEach);
    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeBallCommand(1, PokeballType.MASTER_BALL, BattlerIndex.ENEMY));
    await game.toEndOfTurn();

    const party = game.scene.getPlayerParty();
    expect(party).toHaveLength(3);
    expect(ownerOf(party[2].id)).toBe("guest");
  });

  it("counts the thrower's own pokemon against the limit", async () => {
    await start("host");
    const [host, guest] = game.scene.getPlayerField();
    expect(game.scene.getPlayerParty()).toHaveLength(4);
    expect(isCaptureRosterFull(guest.id)).toBe(true);
    expect(isCaptureRosterFull(host.id)).toBe(false);
  });

  it("applies the thrower's choice to release a pokemon for the catch", async () => {
    const partner = await start("host");
    const released = game.scene.getPlayerParty()[3];
    const caught = game.scene.getEnemyField()[0];
    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeBallCommand(1, PokeballType.MASTER_BALL, BattlerIndex.ENEMY));
    partner.sendDecision({ kind: "capture", seq: 0, action: "replace", releasedId: released.id, insertIndex: 3 });
    await game.toEndOfTurn();

    const party = game.scene.getPlayerParty();
    expect(party).toHaveLength(4);
    expect(partyIds()).not.toContain(released.id);
    expect(party[3].species.speciesId).toBe(caught.species.speciesId);
    expect(ownerOf(party[3].id)).toBe("guest");
    expect(coopSession?.ownership.countOwnedBy("guest", partyIds())).toBe(3);
  });

  it("clears the waiting text once the thrower's choice is applied", async () => {
    const partner = await start("host");
    const released = game.scene.getPlayerParty()[3];
    const showText = vi.spyOn(game.scene.ui, "showText");
    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeBallCommand(1, PokeballType.MASTER_BALL, BattlerIndex.ENEMY));
    partner.sendDecision({ kind: "capture", seq: 0, action: "replace", releasedId: released.id, insertIndex: 3 });
    await game.toEndOfTurn();

    const texts = showText.mock.calls.map(call => call[0]);
    const waiting = texts.indexOf(coopText("waitingForPartnerChoice"));
    expect(waiting).toBeGreaterThan(-1);
    expect(texts[waiting + 1]).toBe("");
  });

  it("applies the thrower's choice to let the catch go", async () => {
    const partner = await start("host");
    const before = partyIds();
    game.move.select(MoveId.SPLASH, BattlerIndex.PLAYER);
    partner.sendCommand(synthesizeBallCommand(1, PokeballType.MASTER_BALL, BattlerIndex.ENEMY));
    partner.sendDecision({ kind: "capture", seq: 0, action: "keepOut" });
    await game.toEndOfTurn();

    expect(partyIds()).toEqual(before);
    expect(game.scene.getEnemyField()[0].isFainted()).toBe(true);
  });

  it("asks the thrower and sends the choice", async () => {
    const partner = await start("guest");
    const before = partyIds();
    partner.sendCommand(synthesizeMoveCommand(0, MoveId.SPLASH));
    game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
      const phase = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
      withCoopBallTarget(BattlerIndex.ENEMY, () => phase.handleCommand(Command.BALL, PokeballType.MASTER_BALL));
    });
    game.onNextPrompt("AttemptCapturePhase", UiMode.OPTION_SELECT, () => {
      const handler = game.scene.ui.getHandler() as OptionSelectUiHandler;
      handler.setCursor(3); // "No": let it go
      handler.processInput(Button.ACTION);
    });
    await game.toEndOfTurn();
    await vi.waitUntil(() => partner.received.some(m => m.t === "choice"));

    expect(partyIds()).toEqual(before);
    const choice = partner.received.find(m => m.t === "choice");
    expect(choice?.t === "choice" && choice.payload).toEqual({ kind: "capture", seq: 0, action: "keepOut" });
  });

  it("reports the released pokemon when the thrower makes room", async () => {
    const partner = await start("guest");
    const guestPokemon = game.scene.getPlayerParty()[2];
    const decision = beginCoopCaptureDecision(guestPokemon.id);
    expect(decision?.isLocal).toBe(true);

    // What the party screen's release does before the capture adds the new pokemon.
    game.scene.getPlayerParty().splice(2, 1);
    decision?.replaced(2);
    await vi.waitUntil(() => partner.received.some(m => m.t === "choice"));

    const choice = partner.received.find(m => m.t === "choice");
    expect(choice?.t === "choice" && choice.payload).toEqual({
      kind: "capture",
      seq: 0,
      action: "replace",
      releasedId: guestPokemon.id,
      insertIndex: 2,
    });
  });

  it("only lets players pick their own pokemon to release or send out", async () => {
    await start("guest");
    const [host, guest] = game.scene.getPlayerField();
    for (const mode of [PartyUiMode.RELEASE, PartyUiMode.SWITCH, PartyUiMode.FAINT_SWITCH]) {
      const filter = wrapCoopPartyFilter(mode, PartyUiHandler.FilterNonFainted);
      expect(filter(host)).toEqual(expect.any(String));
      expect(filter(guest)).toBeNull();
    }
    // Other screens (rewards, checking) may pick anyone.
    expect(wrapCoopPartyFilter(PartyUiMode.MODIFIER, PartyUiHandler.FilterNonFainted)(host)).toBeNull();
  });

  it("does not limit by owner in solo", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER, SpeciesId.PIDGEY);
    const [first] = game.scene.getPlayerParty();
    expect(isCaptureRosterFull(first.id)).toBe(false);
    expect(wrapCoopPartyFilter(PartyUiMode.RELEASE, PartyUiHandler.FilterNonFainted)).toBe(
      PartyUiHandler.FilterNonFainted,
    );
  });
});
