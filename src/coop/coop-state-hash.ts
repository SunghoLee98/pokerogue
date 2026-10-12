/**
 * A compact hash of the battle state both co-op clients must agree on.
 * Each client hashes its own state at the same checkpoints (end of turn, start of wave);
 * a mismatch means the two simulations have diverged.
 * @module
 */

import type { BattleScene } from "#app/battle-scene";
import { globalScene } from "#app/global-scene";
import type { Pokemon } from "#field/pokemon";
import type { PersistentModifier } from "#modifiers/modifier";
import Phaser from "phaser";

export interface CoopPokemonState {
  id: number;
  speciesId: number;
  formIndex: number;
  level: number;
  hp: number;
  /** `StatusEffect`, `0` if none */
  status: number;
  shiny: boolean;
  variant: number;
  /** `0` if not fused */
  fusionSpeciesId: number;
  /** `[moveId, ppUsed]` per move slot */
  moves: [number, number][];
}

export interface CoopStateSnapshot {
  wave: number;
  turn: number;
  money: number;
  /** State of the global seeded RNG (`Phaser.Math.RND`) */
  rngState: string;
  battleSeed: string;
  /** State of the battle-specific RNG, `null` before it is first used */
  battleRngState: string | null;
  playerParty: CoopPokemonState[];
  enemyParty: CoopPokemonState[];
  /** Pokemon ids on the field, in field order */
  playerField: number[];
  enemyField: number[];
  /** `[type id, stack count, holder pokemon id or -1]` */
  modifiers: [string, number, number][];
  enemyModifiers: [string, number, number][];
  /** `WeatherType`, `0` if none */
  weather: number;
  /** `TerrainType`, `0` if none */
  terrain: number;
}

function capturePokemon(pokemon: Pokemon): CoopPokemonState {
  return {
    id: pokemon.id,
    speciesId: pokemon.species.speciesId,
    formIndex: pokemon.formIndex,
    level: pokemon.level,
    hp: pokemon.hp,
    status: pokemon.status?.effect ?? 0,
    shiny: pokemon.shiny,
    variant: pokemon.variant,
    fusionSpeciesId: pokemon.fusionSpecies?.speciesId ?? 0,
    moves: pokemon.getMoveset().map(move => [move.moveId, move.ppUsed]),
  };
}

function captureModifier(modifier: PersistentModifier): [string, number, number] {
  const holderId = "pokemonId" in modifier && typeof modifier.pokemonId === "number" ? modifier.pokemonId : -1;
  return [modifier.type.id, modifier.getStackCount(), holderId];
}

/** Capture the result-relevant battle state as a plain object. */
export function captureCoopState(scene: BattleScene = globalScene): CoopStateSnapshot {
  // `currentBattle` is typed non-null but is `null` between runs.
  const battle = scene.currentBattle as BattleScene["currentBattle"] | null;
  return {
    wave: battle?.waveIndex ?? 0,
    turn: battle?.turn ?? 0,
    money: scene.money,
    rngState: Phaser.Math.RND.state(),
    battleSeed: battle?.battleSeed ?? "",
    // The battle RNG state is private; element access reads it without widening `Battle`.
    battleRngState: battle?.["battleSeedState"] ?? null,
    playerParty: scene.getPlayerParty().map(capturePokemon),
    enemyParty: scene.getEnemyParty().map(capturePokemon),
    playerField: scene.getPlayerField().map(p => p.id),
    enemyField: scene.getEnemyField().map(p => p.id),
    modifiers: scene.modifiers.map(captureModifier),
    enemyModifiers: scene.findModifiers(() => true, false).map(captureModifier),
    weather: scene.arena.weather?.weatherType ?? 0,
    terrain: scene.arena.terrain?.terrainType ?? 0,
  };
}

/** JSON with object keys sorted, so equal states serialize equally regardless of key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = [...Object.keys(record)].sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Two independent 32-bit FNV-1a lanes, giving a 64-bit hash without `BigInt`. */
function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
}

/** @returns A 16 character hex hash of the state */
export function hashCoopState(state: CoopStateSnapshot): string {
  return hash64(canonicalJson(state));
}

/** Capture and hash the current battle state. */
export function computeCoopStateHash(scene: BattleScene = globalScene): string {
  return hashCoopState(captureCoopState(scene));
}
