/**
 * Wire protocol for co-op play: message types, protocol version and join code helpers.
 * @module
 */

import type { Gender } from "#data/gender";
import type { MoveId } from "#enums/move-id";
import type { Nature } from "#enums/nature";
import type { PokeballType } from "#enums/pokeball";
import type { PokemonType } from "#enums/pokemon-type";
import type { SpeciesId } from "#enums/species-id";
import type { Variant } from "#sprites/variant";

/** Bumped whenever a message shape changes incompatibly. Peers with different versions refuse to connect. */
export const COOP_PROTOCOL_VERSION = 2;

export type CoopRole = "host" | "guest";

/**
 * The parts of one player's account data that the battle simulation reads.
 * Both clients must simulate with the same values, so each player's snapshot is shared with the peer.
 * Only JSON-safe values, since it travels over the wire.
 */
export interface CoopAccountSnapshot {
  trainerId: number;
  secretId: number;
  /** Species whose dex entry has a non-zero `caughtAttr` */
  caughtSpecies: number[];
  /** Root species → unlocked egg move bits, non-zero entries only */
  eggMoves: Record<number, number>;
  /** `Unlockables` for which `isUnlocked` returns `true` (overrides included) */
  unlocks: number[];
}

/** The host's world-level account data sent in the `start` message. */
export type CoopWorldData = CoopAccountSnapshot;

/**
 * Everything needed to create one player's starter on both clients.
 * Built by the owner from their own account; the peer creates the pokemon from this alone,
 * so it holds every value that depends on the owner's account.
 */
export interface CoopStarterPayload {
  speciesId: SpeciesId;
  formIndex: number;
  gender: Gender;
  shiny: boolean;
  variant: Variant;
  abilityIndex: number;
  passive: boolean;
  nature: Nature;
  ivs: number[];
  /** Includes egg moves. Empty for the default moveset. */
  moveset: MoveId[];
  teraType: PokemonType;
  friendship: number;
  pokeball: PokeballType;
  nickname?: string;
  pokerus: boolean;
  /** Luck from the owner's dex entry */
  luck: number;
}

/** A `TurnCommand` (`src/battle.ts`) as JSON. Its `move` and `args` hold plain data only. */
export interface CoopTurnCommandData {
  command: number;
  cursor?: number;
  move?: { move: number; targets: number[]; useMode: number };
  targets?: number[];
  skip?: boolean;
  args?: unknown[];
}

/** One player's final command for one field slot, as the simulation will run it. */
export interface CoopTurnCommandPayload {
  fieldIndex: number;
  turnCommand: CoopTurnCommandData;
  /** The slot's pre-turn command (terastallizing), `null` if none */
  preTurnCommand: CoopTurnCommandData | null;
}

/**
 * A choice a player makes while the turn is running, keyed by a sequence number both simulations count the same way.
 * - `switch`: the pokemon sent out (`slotIndex`, a `PartyOption` in `option`); `slotIndex` outside the party for none
 * - `capture`: after catching with a full roster, the pokemon released to make room (`replace`) or the catch let go
 */
export type CoopDecision =
  | { kind: "switch"; seq: number; slotIndex: number; option: number }
  | { kind: "capture"; seq: number; action: "replace"; releasedId: number; insertIndex: number }
  | { kind: "capture"; seq: number; action: "keepOut" };

// Payloads below are narrowed by later co-op plans.
export type TurnCommandPayload = CoopTurnCommandPayload;
export type CoopSessionSnapshot = Record<string, unknown>;
export type CoopChoiceKind = string;

export type CoopMessage =
  | { t: "hello"; gameVersion: string; protocol: number; accountName: string }
  /**
   * A player's starter selection. `picks` is only filled while `ready` (only confirmed picks are shown to the peer).
   * `account` is the sender's account snapshot, read for their pokemon once the run starts.
   */
  | { t: "starters"; picks: CoopStarterPayload[]; ready: boolean; account: CoopAccountSnapshot }
  /**
   * Sent by the host only, when both players are ready. Everything both clients need to create the same run:
   * the shared seed, both account snapshots, both players' picks and the host's active timed event (`null` for none).
   */
  | {
      t: "start";
      seed: string;
      hostWorldData: CoopWorldData;
      guestAccount: CoopAccountSnapshot;
      hostPicks: CoopStarterPayload[];
      guestPicks: CoopStarterPayload[];
      timedEvent: string | null;
    }
  | { t: "turnCommand"; turn: number; wave: number; command: TurnCommandPayload }
  | { t: "choice"; kind: CoopChoiceKind; wave: number; payload: unknown }
  | { t: "ping"; kind: CoopChoiceKind; payload: unknown }
  | { t: "checksum"; wave: number; turn: number; hash: string }
  /** The guest requests without `seq`; the host confirms by attaching one. */
  | { t: "shopBuy"; wave: number; seq?: number; option: number; target: number }
  /** For `flee`, `turn` is the battle turn of the declined proposal. */
  | { t: "confirm"; kind: "mePokemon" | "meOption" | "flee"; wave: number; turn: number; accepted: boolean }
  | { t: "resume"; session: CoopSessionSnapshot }
  | { t: "bye" };

const COOP_MESSAGE_KINDS = [
  "hello",
  "starters",
  "start",
  "turnCommand",
  "choice",
  "ping",
  "checksum",
  "shopBuy",
  "confirm",
  "resume",
  "bye",
] as const satisfies readonly CoopMessage["t"][];

const coopMessageKinds: ReadonlySet<string> = new Set(COOP_MESSAGE_KINDS);

export function encodeCoopMessage(message: CoopMessage): string {
  return JSON.stringify(message);
}

/**
 * Decode a raw frame into a {@linkcode CoopMessage}.
 * Only the message kind is checked; fields are trusted since co-op has no cheat protection.
 * @returns The decoded message, or `null` if the frame is not a known co-op message
 */
export function decodeCoopMessage(raw: string): CoopMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const kind = (parsed as { t?: unknown }).t;
  if (typeof kind !== "string" || !coopMessageKinds.has(kind)) {
    return null;
  }
  return parsed as CoopMessage;
}

/**
 * Normalize a typed join code, forgiving whitespace, hyphens and lowercase letters.
 * @returns The 6-character uppercase code, or `null` if the input is not a valid code
 */
export function normalizeJoinCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z0-9]{6}$/.test(code) ? code : null;
}
