import type { CoopAccountSnapshot, CoopMessage, CoopRole } from "#coop/coop-protocol";
import { setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { computeCoopStateHash } from "#coop/coop-state-hash";
import { BattlerIndex } from "#enums/battler-index";
import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { MysteryEncounterType } from "#enums/mystery-encounter-type";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand, waitForCoop } from "#test/utils/coop-partner";
import {
  createFreshGameManager,
  createTestStarterPayload,
  startCoopBattle,
  startCoopEncounter,
} from "#test/utils/coop-replay";
import type { ConfirmUiHandler } from "#ui/confirm-ui-handler";
import type { MysteryEncounterUiHandler } from "#ui/mystery-encounter-ui-handler";
import type { PartyUiHandler } from "#ui/party-ui-handler";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

/** The host owns Bulbasaur (slot 0), the guest Charmander (slot 1). */
const startInfo = (): CoopStartInfo => ({
  seed: "coop-choice-replay",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

/** Messages that carry a player's choice. */
const isChoice = (m: CoopMessage) => m.t === "choice" || m.t === "confirm";

interface RunResult {
  hash: string;
  /** Choices the local client sent */
  sent: CoopMessage[];
}

/**
 * Pokemon choices across both clients: the host's client runs first, with the guest's messages made up by the test;
 * then the guest's client runs with the host's recorded messages. Both must end in the same state, and the guest's
 * real messages must be the made-up ones.
 */
describe("co-op choice replay", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  const party = () => game.scene.getPlayerParty();

  async function selectInParty(slot: number): Promise<void> {
    await waitForCoop(() => game.scene.ui.mode === UiMode.PARTY);
    const partyUi = game.scene.ui.getHandler() as PartyUiHandler;
    partyUi.setCursor(slot);
    partyUi.processInput(Button.ACTION);
    partyUi.processInput(Button.ACTION);
  }

  async function answer(accept: boolean): Promise<void> {
    await waitForCoop(() => game.scene.ui.mode === UiMode.CONFIRM);
    const confirm = game.scene.ui.getHandler() as ConfirmUiHandler;
    confirm.setCursor(accept ? 0 : 1);
    confirm.processInput(Button.ACTION);
  }

  /** Run Part-Timer's first option to its end and hash the state. */
  async function runPartTimer(role: CoopRole, act: (partner: CoopTestPartner) => Promise<void>): Promise<RunResult> {
    game.override.startingWave(13).moveset([MoveId.TACKLE]);
    const partner = new CoopTestPartner(role);
    try {
      await startCoopEncounter(game, {
        role,
        start: startInfo(),
        transport: partner.localTransport,
        encounter: MysteryEncounterType.PART_TIMER,
      });
      game.onNextPrompt(
        "MysteryEncounterOptionSelectedPhase",
        UiMode.MESSAGE,
        () => game.scene.ui.getHandler().processInput(Button.ACTION),
        () => game.isCurrentPhase("MysteryEncounterRewardsPhase"),
      );
      await act(partner);
      await game.phaseInterceptor.to("MysteryEncounterRewardsPhase", false);
      return { hash: computeCoopStateHash(), sent: partner.received.filter(isChoice) };
    } finally {
      setCoopSession(null);
    }
  }

  /** Give the guest's messages from the host run to the host's recorded ones, and vice versa. */
  const fromHost = (host: RunResult) => host.sent;

  it.each([
    { accept: true, picked: 1 },
    { accept: false, picked: 0 },
  ])("an encounter pick of the partner's pokemon (owner accepts: $accept)", async ({ accept, picked }) => {
    const WAVE = 13;
    const guestAnswer: CoopMessage = { t: "confirm", kind: "mePokemon", wave: WAVE, seq: 0, accepted: accept };

    // The host picks the guest's Charmander; the guest answers.
    const host = await runPartTimer("host", async partner => {
      (game.scene.ui.getHandler() as MysteryEncounterUiHandler).processInput(Button.ACTION);
      await selectInParty(1);
      await waitForCoop(() => partner.received.some(m => m.t === "choice" && m.kind === "ownerAsk"));
      partner.send(guestAnswer);
      if (!accept) {
        await waitForCoop(() => game.scene.ui.mode === UiMode.MESSAGE);
        game.scene.ui.getHandler().processInput(Button.ACTION);
        await selectInParty(0);
      }
    });
    const hostWorked = party()[picked].moveset[0].ppUsed;
    expect(hostWorked).toBeGreaterThan(0);

    game = createFreshGameManager(phaserGame);
    const guest = await runPartTimer("guest", async partner => {
      const recorded = fromHost(host);
      const ask = recorded.findIndex(m => m.t === "choice" && m.kind === "ownerAsk");
      for (const message of recorded.slice(0, ask + 1)) {
        partner.send(message);
      }
      await answer(accept);
      await waitForCoop(() => partner.received.some(m => m.t === "confirm"));
      for (const message of recorded.slice(ask + 1)) {
        partner.send(message);
      }
    });

    expect(guest.sent).toEqual([guestAnswer]);
    expect(guest.hash).toBe(host.hash);
    expect(party()[picked].moveset[0].ppUsed).toBe(hostWorked);
    expect(party()[1 - picked].moveset[0].ppUsed).toBe(0);
  });

  /** Queue a phase about the guest's Charmander, play one turn and hash the state. */
  async function runOwnerChoice(
    role: CoopRole,
    queue: () => void,
    act: (partner: CoopTestPartner) => Promise<void>,
  ): Promise<RunResult> {
    game.override
      .battleStyle(null)
      .disableTrainerWaves()
      .startingWave(3)
      .startingLevel(20)
      .enemyLevel(5)
      .enemyMoveset(MoveId.SPLASH);
    const partner = new CoopTestPartner(role);
    try {
      await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
      for (const pokemon of party()) {
        game.move.changeMoveset(pokemon, [MoveId.SPLASH, MoveId.TACKLE, MoveId.GROWL, MoveId.SCRATCH]);
      }
      queue();
      game.move.select(MoveId.SPLASH, role === "host" ? BattlerIndex.PLAYER : BattlerIndex.PLAYER_2);
      partner.sendCommand(synthesizeMoveCommand(role === "host" ? 1 : 0, MoveId.SPLASH));
      const turn = game.toEndOfTurn();
      await act(partner);
      await turn;
      return { hash: computeCoopStateHash(), sent: partner.received.filter(isChoice) };
    } finally {
      setCoopSession(null);
    }
  }

  it("the owner chooses the move their pokemon forgets", async () => {
    const queue = () => game.scene.phaseManager.unshiftNew("LearnMovePhase", 1, MoveId.EMBER);
    const decision: CoopMessage = {
      t: "choice",
      kind: "learnMove",
      wave: 3,
      payload: { kind: "learnMove", seq: 0, moveIndex: 2 },
    };
    const host = await runOwnerChoice("host", queue, async partner => partner.send(decision));

    game = createFreshGameManager(phaserGame);
    const guest = await runOwnerChoice("guest", queue, async () => {
      await waitForCoop(() => game.scene.ui.mode === UiMode.CONFIRM);
      game.scene.ui.getHandler().processInput(Button.ACTION);
      await waitForCoop(() => game.scene.ui.mode === UiMode.SUMMARY);
      game.scene.ui.getHandler().setCursor(2);
      game.scene.ui.getHandler().processInput(Button.ACTION);
    });

    expect(guest.sent).toEqual([decision]);
    expect(guest.hash).toBe(host.hash);
    expect(party()[1].moveset[2]?.moveId).toBe(MoveId.EMBER);
  });

  it("the owner lets their pokemon evolve", async () => {
    const queue = () => {
      const charmander = party()[1];
      game.scene.phaseManager.unshiftNew("EvolutionPhase", charmander, charmander.getEvolution(), charmander.level - 1);
    };
    const decision: CoopMessage = {
      t: "choice",
      kind: "evolution",
      wave: 3,
      payload: { kind: "evolution", seq: 0, cancelled: false, paused: false },
    };
    const host = await runOwnerChoice("host", queue, async partner => partner.send(decision));

    game = createFreshGameManager(phaserGame);
    const guest = await runOwnerChoice("guest", queue, async () => {});

    expect(guest.sent).toEqual([decision]);
    expect(guest.hash).toBe(host.hash);
    expect(party()[1].species.speciesId).toBe(SpeciesId.CHARMELEON);
  });
});
