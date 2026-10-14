import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { resumeCoopRun } from "#coop/coop-resume";
import { submitCoopRewardAction } from "#coop/coop-reward";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { computeCoopStateHash } from "#coop/coop-state-hash";
import { BattleStyle } from "#enums/battle-style";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { SelectModifierPhase } from "#phases/select-modifier-phase";
import type { TitlePhase } from "#phases/title-phase";
import type { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeMoveCommand } from "#test/utils/coop-partner";
import {
  answerWaveStartSwitchPrompt,
  applyTestAccount,
  createFreshGameManager,
  createTestStarterPayload,
  toCoopRewardScreen,
} from "#test/utils/coop-replay";
import type { SessionSaveData } from "#types/save-data";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: trainerId * 7,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-resume",
  accounts: { host: snapshot(1111), guest: snapshot(2222) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR), createTestStarterPayload(SpeciesId.PIDGEY)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER), createTestStarterPayload(SpeciesId.RATTATA)],
  },
  timedEvent: null,
});

const FIELD = { host: 0, guest: 1 } as const;

function setUp(game: GameManager): void {
  game.override
    .battleStyle(null)
    .disableTrainerWaves()
    .startingLevel(100)
    .enemyLevel(5)
    .enemyMoveset(MoveId.SPLASH)
    .moveset([MoveId.HYPER_VOICE, MoveId.SPLASH]);
}

/** Play wave 1 as the host and return the session saved at the start of wave 2. */
async function saveAtWaveTwo(game: GameManager): Promise<SessionSaveData> {
  setUp(game);
  await toCoopRewardScreen(game, "host", 1, startInfo());
  submitCoopRewardAction(game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase, { kind: "skip" });
  await game.phaseInterceptor.to("CommandPhase");
  expect(game.scene.currentBattle.waveIndex).toBe(2);
  // The test framework keeps the last save made by `saveAll` (at the start of wave 2).
  return game.reload["sessionData"];
}

interface ResumedRun {
  hashes: string[];
  ownership: Record<number, CoopRole>;
  partyIds: number[];
  fieldIds: number[];
  phases: string[];
  /** The wave start switch answers the local client sent */
  answers: unknown[];
}

interface ResumeOptions {
  /** The local player's battle style */
  style?: BattleStyle;
  /** The party slot each player sends out when asked whether to switch after resuming; `null` to stay */
  switchTo?: Partial<Record<CoopRole, number>>;
}

/** Resume the saved run on a fresh game as `role`, then play one turn of Splash on both sides. */
async function resumeAs(
  game: GameManager,
  role: CoopRole,
  json: string,
  { style = BattleStyle.SET, switchTo = {} }: ResumeOptions = {},
): Promise<ResumedRun> {
  setUp(game);
  game.settings.battleStyle(style);
  // Each client has its own account data.
  applyTestAccount(game.scene.gameData, {
    trainerId: role === "host" ? 1111 : 2222,
    secretId: 1,
    unlocks: [],
    caughtSpecies: [],
    eggMoves: {},
  });
  const partner = new CoopTestPartner(role);
  const partnerRole: CoopRole = role === "host" ? "guest" : "host";
  partner.waveStartSwitch = () => switchTo[partnerRole] ?? null;
  await game.runToTitle();
  game.onNextPrompt("TitlePhase", UiMode.TITLE, async () => {
    const title = game.scene.phaseManager.getCurrentPhase() as TitlePhase;
    await resumeCoopRun(role, partner.localTransport, json);
    title["loaded"] = true;
    title.end();
  });
  if (style === BattleStyle.SWITCH) {
    answerWaveStartSwitchPrompt(game, switchTo[role] ?? null);
  }
  await game.phaseInterceptor.to("CommandPhase");
  const hashes = [computeCoopStateHash()];

  game.move.select(MoveId.SPLASH, FIELD[role]);
  partner.sendCommand(synthesizeMoveCommand(FIELD[role === "host" ? "guest" : "host"], MoveId.SPLASH));
  await game.toEndOfTurn();
  hashes.push(computeCoopStateHash());

  return {
    hashes,
    ownership: coopSession!.ownership.toJSON(),
    partyIds: game.scene.getPlayerParty().map(p => p.id),
    fieldIds: game.scene.getPlayerField().map(p => p.id),
    phases: [...game.phaseInterceptor.phaseLog],
    answers: partner.received.flatMap(m => (m.t === "choice" && m.kind === "waveStartSwitch" ? [m.payload] : [])),
  };
}

describe("resuming a saved co-op run", () => {
  let phaserGame: Phaser.Game;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    setCoopSession(null);
  });

  it("host and guest resume into the same state", async () => {
    const saved = await saveAtWaveTwo(createFreshGameManager(phaserGame));
    expect(saved.coop).toBeDefined();
    const json = JSON.stringify(saved);

    const host = await resumeAs(createFreshGameManager(phaserGame), "host", json);
    setCoopSession(null);
    const guest = await resumeAs(createFreshGameManager(phaserGame), "guest", json);

    expect(guest.hashes).toEqual(host.hashes);
    expect(host.ownership).toEqual(saved.coop?.ownership);
    expect(guest.ownership).toEqual(saved.coop?.ownership);
    expect(guest.partyIds).toEqual(host.partyIds);
  });

  it("resumes into the same state with different battle styles and a switch by the guest", async () => {
    const saved = await saveAtWaveTwo(createFreshGameManager(phaserGame));
    const json = JSON.stringify(saved);
    // The party is ordered host, guest, then the benches: Bulbasaur, Charmander, Pidgey, Rattata.
    const switchTo = { guest: 3 };

    const host = await resumeAs(createFreshGameManager(phaserGame), "host", json, {
      style: BattleStyle.SWITCH,
      switchTo,
    });
    setCoopSession(null);
    const guest = await resumeAs(createFreshGameManager(phaserGame), "guest", json, {
      style: BattleStyle.SWITCH,
      switchTo,
    });
    setCoopSession(null);
    const setGuest = await resumeAs(createFreshGameManager(phaserGame), "guest", json, { switchTo: {} });

    expect(guest.hashes).toEqual(host.hashes);
    expect(guest.partyIds).toEqual(host.partyIds);
    expect(host.fieldIds).toEqual([saved.party[0].id, saved.party[3].id]);
    expect(guest.answers).toEqual([{ kind: "waveStartSwitch", seq: saved.coop!.decisionSeq + 1, slotIndex: 3 }]);
    // A guest playing "Set" is not asked and keeps its pokemon in.
    expect(setGuest.fieldIds).toEqual([saved.party[0].id, saved.party[1].id]);
    expect(setGuest.answers).toEqual([{ kind: "waveStartSwitch", seq: saved.coop!.decisionSeq + 1, slotIndex: -1 }]);
  });

  it("puts each player's pokemon in their own slot and asks each about their own", async () => {
    const saved = await saveAtWaveTwo(createFreshGameManager(phaserGame));
    const game = createFreshGameManager(phaserGame);
    const run = await resumeAs(game, "guest", JSON.stringify(saved));

    const field = game.scene.getPlayerField();
    expect(field.map(p => run.ownership[p.id])).toEqual(["host", "guest"]);
    expect(run.phases.filter(p => p === "CheckSwitchPhase")).toHaveLength(2);
    expect(run.answers).toHaveLength(1);
    expect(game.scene.gameMode.isCoop).toBe(true);
    expect(game.scene.sessionSlotId).toBe(5);
  });
});
