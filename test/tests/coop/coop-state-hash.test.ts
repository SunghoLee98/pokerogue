import { CoopSession, setCoopSession } from "#coop/coop-session";
import {
  type CoopPokemonState,
  type CoopStateSnapshot,
  captureCoopState,
  computeCoopStateHash,
  hashCoopState,
} from "#coop/coop-state-hash";
import { createLoopbackPair } from "#coop/loopback-transport";
import { BattlerIndex } from "#enums/battler-index";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

function pokemonState(id: number): CoopPokemonState {
  return {
    id,
    speciesId: SpeciesId.BULBASAUR,
    formIndex: 0,
    level: 5,
    hp: 20,
    status: 0,
    shiny: false,
    variant: 0,
    fusionSpeciesId: 0,
    moves: [[MoveId.TACKLE, 0]],
    owner: null,
  };
}

function state(): CoopStateSnapshot {
  return {
    wave: 1,
    turn: 1,
    money: 1000,
    rngState: "!rnd,1,2,3,4",
    battleSeed: "seed",
    battleRngState: null,
    playerParty: [pokemonState(1), pokemonState(2)],
    enemyParty: [pokemonState(3)],
    playerField: [1, 2],
    enemyField: [3],
    modifiers: [["EXP_SHARE", 1, -1]],
    enemyModifiers: [],
    weather: 0,
    terrain: 0,
  };
}

describe("coop-state-hash", () => {
  describe("hashCoopState", () => {
    it("is a 16 character hex string", () => {
      expect(hashCoopState(state())).toMatch(/^[0-9a-f]{16}$/);
    });

    it("hashes equal states equally", () => {
      const reordered = Object.fromEntries(Object.entries(state()).reverse()) as unknown as CoopStateSnapshot;
      expect(hashCoopState(reordered)).toBe(hashCoopState(state()));
    });

    it("changes when hp, status, shininess or rng state changes", () => {
      const base = hashCoopState(state());
      const changes: ((s: CoopStateSnapshot) => void)[] = [
        s => (s.enemyParty[0].hp = 19),
        s => (s.playerParty[1].status = 1),
        s => (s.enemyParty[0].shiny = true),
        s => (s.rngState = "!rnd,1,2,3,5"),
        s => (s.money = 999),
        s => (s.playerField = [2, 1]),
      ];
      for (const change of changes) {
        const changed = state();
        change(changed);
        expect(hashCoopState(changed)).not.toBe(base);
      }
    });
  });

  describe("captureCoopState", () => {
    let phaserGame: Phaser.Game;
    let game: GameManager;

    beforeAll(() => {
      phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
    });

    beforeEach(() => {
      game = new GameManager(phaserGame);
      game.override
        .battleStyle("double")
        .enemySpecies(SpeciesId.MAGIKARP)
        .enemyMoveset(MoveId.SPLASH)
        .moveset(MoveId.TACKLE)
        .startingLevel(5)
        .enemyLevel(50);
    });

    it("captures both fields and parties", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER, SpeciesId.SQUIRTLE);
      const captured = captureCoopState();

      expect(captured.wave).toBe(game.scene.currentBattle.waveIndex);
      expect(captured.playerParty.map(p => p.speciesId)).toEqual([
        SpeciesId.BULBASAUR,
        SpeciesId.CHARMANDER,
        SpeciesId.SQUIRTLE,
      ]);
      expect(captured.playerField).toEqual(game.scene.getPlayerField().map(p => p.id));
      expect(captured.enemyField).toHaveLength(2);
      expect(captured.money).toBe(game.scene.money);
      expect(captured.rngState).toBe(Phaser.Math.RND.state());
    });

    it("records who owns each party pokemon in co-op", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
      const [bulbasaur, charmander] = game.scene.getPlayerParty();
      expect(captureCoopState().playerParty.map(p => p.owner)).toEqual([null, null]);

      const session = new CoopSession("host", createLoopbackPair().host);
      session.ownership.set(bulbasaur.id, "host");
      session.ownership.set(charmander.id, "guest");
      setCoopSession(session);
      try {
        const before = computeCoopStateHash();
        expect(captureCoopState().playerParty.map(p => p.owner)).toEqual(["host", "guest"]);
        session.ownership.set(charmander.id, "host");
        expect(computeCoopStateHash()).not.toBe(before);
      } finally {
        setCoopSession(null);
      }
    });

    it("is stable when nothing happens", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
      expect(computeCoopStateHash()).toBe(computeCoopStateHash());
    });

    it("changes after a turn that deals damage", async () => {
      await game.classicMode.startBattle(SpeciesId.BULBASAUR, SpeciesId.CHARMANDER);
      const before = computeCoopStateHash();

      game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER, BattlerIndex.ENEMY);
      game.move.select(MoveId.TACKLE, BattlerIndex.PLAYER_2, BattlerIndex.ENEMY_2);
      await game.toEndOfTurn();

      expect(game.scene.getEnemyField().some(p => p.hp < p.getMaxHp())).toBe(true);
      expect(computeCoopStateHash()).not.toBe(before);
    });
  });
});
