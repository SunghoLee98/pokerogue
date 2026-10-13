import { coopCreditsLocalAccount } from "#coop/coop-account";
import { withCoopBallTarget } from "#coop/coop-ball";
import type { CoopAccountSnapshot, CoopRole } from "#coop/coop-protocol";
import { coopSession, setCoopSession } from "#coop/coop-session";
import type { CoopStartInfo } from "#coop/coop-starter-selection";
import { BattlerIndex } from "#enums/battler-index";
import { Command } from "#enums/command";
import { MoveId } from "#enums/move-id";
import { PokeballType } from "#enums/pokeball";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { PlayerPokemon } from "#field/pokemon";
import type { CommandPhase } from "#phases/command-phase";
import { GameManager } from "#test/framework/game-manager";
import { CoopTestPartner, synthesizeBallCommand, synthesizeMoveCommand } from "#test/utils/coop-partner";
import { createTestStarterPayload, startCoopBattle } from "#test/utils/coop-replay";
import Phaser from "phaser";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const snapshot = (trainerId: number): CoopAccountSnapshot => ({
  trainerId,
  secretId: 0,
  caughtSpecies: [],
  eggMoves: {},
  unlocks: [],
});

const startInfo = (): CoopStartInfo => ({
  seed: "coop-account",
  accounts: { host: snapshot(1), guest: snapshot(2) },
  picks: {
    host: [createTestStarterPayload(SpeciesId.BULBASAUR)],
    guest: [createTestStarterPayload(SpeciesId.CHARMANDER)],
  },
  timedEvent: null,
});

describe("co-op account credit", () => {
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
      .enemySpecies(SpeciesId.RATTATA)
      .enemyMoveset(MoveId.SPLASH)
      .moveset([MoveId.SPLASH]);
  });

  afterEach(() => {
    setCoopSession(null);
  });

  async function start(role: CoopRole): Promise<CoopTestPartner> {
    const partner = new CoopTestPartner(role);
    await startCoopBattle(game, { role, start: startInfo(), transport: partner.localTransport });
    return partner;
  }

  /** The party pokemon each player owns. */
  function owned(): Record<CoopRole, PlayerPokemon> {
    const [host, guest] = game.scene.getPlayerParty();
    expect(coopSession?.ownership.get(host.id)).toBe("host");
    expect(coopSession?.ownership.get(guest.id)).toBe("guest");
    return { host, guest };
  }

  /** Forget the dex entry of a species, as for an account that never caught it. */
  function forget(speciesId: SpeciesId): void {
    const entry = game.scene.gameData.dexData[speciesId];
    entry.seenAttr = 0n;
    entry.caughtAttr = 0n;
    entry.caughtCount = 0;
    entry.seenCount = 0;
    entry.ivs = [0, 0, 0, 0, 0, 0];
    game.scene.gameData.starterData[speciesId].candyCount = 0;
  }

  it("credits every pokemon outside co-op", async () => {
    await game.classicMode.startBattle(SpeciesId.BULBASAUR);
    expect(coopCreditsLocalAccount(game.field.getPlayerPokemon())).toBe(true);
    expect(coopCreditsLocalAccount(game.field.getEnemyPokemon())).toBe(true);
  });

  it("credits the local player's pokemon and the enemies, not the partner's pokemon", async () => {
    await start("host");
    const { host, guest } = owned();
    expect(coopCreditsLocalAccount(host)).toBe(true);
    expect(coopCreditsLocalAccount(guest)).toBe(false);
    expect(coopCreditsLocalAccount(game.scene.getEnemyField()[0])).toBe(true);
  });

  it("credits the guest's own pokemon on the guest's client", async () => {
    await start("guest");
    const { host, guest } = owned();
    expect(coopCreditsLocalAccount(host)).toBe(false);
    expect(coopCreditsLocalAccount(guest)).toBe(true);
  });

  it("only marks the partner's pokemon as seen when it is caught", async () => {
    await start("host");
    const { guest } = owned();
    forget(SpeciesId.CHARMANDER);
    const entry = game.scene.gameData.dexData[SpeciesId.CHARMANDER];

    const newStarter = await game.scene.gameData.setPokemonCaught(guest);

    expect(newStarter).toBe(false);
    expect(entry.caughtAttr).toBe(0n);
    expect(entry.caughtCount).toBe(0);
    expect(entry.seenAttr).not.toBe(0n);
    expect(entry.seenCount).toBe(0);
    expect(game.scene.gameData.starterData[SpeciesId.CHARMANDER].candyCount).toBe(0);
  });

  it("records the local player's own catch as in solo", async () => {
    await start("guest");
    const { guest } = owned();
    forget(SpeciesId.CHARMANDER);
    const entry = game.scene.gameData.dexData[SpeciesId.CHARMANDER];

    await game.scene.gameData.setPokemonCaught(guest, true, false, false);

    expect(entry.caughtAttr).not.toBe(0n);
    expect(entry.caughtCount).toBe(1);
    expect(game.scene.gameData.starterData[SpeciesId.CHARMANDER].candyCount).toBeGreaterThan(0);
  });

  describe("catches", () => {
    /** Throw a Master Ball at the first enemy from `thrower`'s slot while the other player uses Splash. */
    async function catchFirstEnemy(local: CoopRole, thrower: CoopRole): Promise<void> {
      const partner = await start(local);
      game.scene.pokeballCounts[PokeballType.MASTER_BALL] = 5;
      forget(SpeciesId.RATTATA);
      const throwerSlot = thrower === "host" ? 0 : 1;
      if (thrower === local) {
        game.onNextPrompt("CommandPhase", UiMode.COMMAND, () => {
          const phase = game.scene.phaseManager.getCurrentPhase() as CommandPhase;
          withCoopBallTarget(BattlerIndex.ENEMY, () => phase.handleCommand(Command.BALL, PokeballType.MASTER_BALL));
        });
        partner.sendCommand(synthesizeMoveCommand(1 - throwerSlot, MoveId.SPLASH));
      } else {
        game.move.select(MoveId.SPLASH, local === "host" ? BattlerIndex.PLAYER : BattlerIndex.PLAYER_2);
        partner.sendCommand(synthesizeBallCommand(throwerSlot, PokeballType.MASTER_BALL, BattlerIndex.ENEMY));
      }
      await game.toEndOfTurn();
      expect(game.scene.getPlayerParty()).toHaveLength(3);
    }

    const entry = () => game.scene.gameData.dexData[SpeciesId.RATTATA];

    it("does not record the partner's catch on the local account", async () => {
      await catchFirstEnemy("host", "guest");
      expect(entry().caughtAttr).toBe(0n);
      expect(entry().caughtCount).toBe(0);
      expect(entry().ivs).toEqual([0, 0, 0, 0, 0, 0]);
      expect(entry().seenAttr).not.toBe(0n);
    });

    it("records the guest's own catch on the guest's client", async () => {
      await catchFirstEnemy("guest", "guest");
      expect(entry().caughtAttr).not.toBe(0n);
      expect(entry().caughtCount).toBe(1);
      expect(entry().ivs.some(iv => iv > 0)).toBe(true);
    });

    it("records the host's own catch on the host's client", async () => {
      await catchFirstEnemy("host", "host");
      expect(entry().caughtCount).toBe(1);
    });
  });
});
