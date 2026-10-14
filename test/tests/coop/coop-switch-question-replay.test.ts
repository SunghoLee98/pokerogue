import { findFirstDesync } from "#coop/coop-desync";
import type { CoopRole } from "#coop/coop-protocol";
import { BattleStyle } from "#enums/battle-style";
import type { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import {
  type CoopReplayCommandFn,
  type CoopReplayLog,
  type CoopReplayOptions,
  type CoopTestAccount,
  createFreshGameManager,
  inputsBy,
  runCoopReplay,
} from "#test/utils/coop-replay";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const hostAccount: CoopTestAccount = {
  trainerId: 12345,
  secretId: 54321,
  unlocks: [],
  caughtSpecies: [],
  eggMoves: {},
};
const guestAccount: CoopTestAccount = { trainerId: 777, secretId: 888, unlocks: [], caughtSpecies: [], eggMoves: {} };

/** Party slots at the start: host lead, guest lead, host bench, guest bench. */
const BENCH_SLOT: Record<CoopRole, number> = { host: 2, guest: 3 };

/** The wave start "switch?" answers a player sent, as `[wave, slot]`. */
function answers(log: CoopReplayLog, role: CoopRole): [number, number][] {
  return inputsBy(log, role).flatMap(({ message }) =>
    message.t === "choice" && message.kind === "waveStartSwitch"
      ? [[message.wave, (message.payload as { slotIndex: number }).slotIndex] as [number, number]]
      : [],
  );
}

/**
 * The wave start switch question across both clients: recorded as the host (the guest's answers made up from its
 * script and its battle style), then replayed as the guest with its own battle style. Both must end in the same state.
 */
describe("co-op wave start switch question replay", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
  });

  /** Attack the first living enemy. */
  const attack: CoopReplayCommandFn = () => {
    const target = game.scene.getEnemyField().find(p => p && !p.isFainted()) ?? game.scene.getEnemyField()[0];
    return { kind: "move", moveId: MoveId.TACKLE, target: target.getBattlerIndex() as BattlerIndex };
  };

  async function recordAndReplay(
    options: Pick<CoopReplayOptions, "styles" | "waveStartSwitch">,
  ): Promise<{ hostLog: CoopReplayLog; guestLog: CoopReplayLog }> {
    const common = {
      accounts: { host: hostAccount, guest: guestAccount },
      species: [SpeciesId.SQUIRTLE, SpeciesId.CHARMANDER] as [SpeciesId, SpeciesId],
      benches: { host: [SpeciesId.PIDGEY], guest: [SpeciesId.RATTATA] },
      waves: 2,
      localCommand: attack,
      ...options,
    };
    game.override.moveset([MoveId.TACKLE, MoveId.SPLASH]);
    const hostLog = await runCoopReplay(game, { ...common, role: "host", remote: { command: attack } });

    game = createFreshGameManager(phaserGame);
    game.override.moveset([MoveId.TACKLE, MoveId.SPLASH]);
    const guestLog = await runCoopReplay(game, { ...common, role: "guest", remote: { log: hostLog } });
    return { hostLog, guestLog };
  }

  function expectInSync({ hostLog, guestLog }: { hostLog: CoopReplayLog; guestLog: CoopReplayLog }): void {
    expect(findFirstDesync(hostLog.checksums, guestLog.checksums)).toBeNull();
    expect(guestLog.checksums.length).toBeGreaterThan(2);
    expect(inputsBy(guestLog, "guest")).toEqual(inputsBy(hostLog, "guest"));
    expect(inputsBy(guestLog, "host")).toEqual(inputsBy(hostLog, "host"));
  }

  it("host plays Switch and switches, guest plays Set", async () => {
    const logs = await recordAndReplay({
      styles: { host: BattleStyle.SWITCH, guest: BattleStyle.SET },
      waveStartSwitch: (role, wave) => (role === "host" && wave === 2 ? BENCH_SLOT.host : null),
    });

    expectInSync(logs);
    expect(answers(logs.hostLog, "host")).toEqual([
      [1, -1],
      [2, BENCH_SLOT.host],
    ]);
    // The guest's own script would switch, but playing Set it is never asked.
    expect(answers(logs.guestLog, "guest")).toEqual([
      [1, -1],
      [2, -1],
    ]);
  });

  it("host plays Set, guest plays Switch and switches", async () => {
    const logs = await recordAndReplay({
      styles: { host: BattleStyle.SET, guest: BattleStyle.SWITCH },
      waveStartSwitch: role => (role === "guest" ? BENCH_SLOT.guest : BENCH_SLOT.host),
    });

    expectInSync(logs);
    expect(answers(logs.hostLog, "host")).toEqual([
      [1, -1],
      [2, -1],
    ]);
    expect(answers(logs.guestLog, "guest")).toEqual([
      [1, BENCH_SLOT.guest],
      [2, BENCH_SLOT.guest],
    ]);
  });

  it("both play Switch and both switch", async () => {
    const logs = await recordAndReplay({
      styles: { host: BattleStyle.SWITCH, guest: BattleStyle.SWITCH },
      waveStartSwitch: (role, wave) => (wave === 1 ? BENCH_SLOT[role] : null),
    });

    expectInSync(logs);
    expect(answers(logs.guestLog, "host")).toEqual([
      [1, BENCH_SLOT.host],
      [2, -1],
    ]);
    expect(answers(logs.guestLog, "guest")).toEqual([
      [1, BENCH_SLOT.guest],
      [2, -1],
    ]);
  });
});
