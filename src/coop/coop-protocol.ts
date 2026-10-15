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
export const COOP_PROTOCOL_VERSION = 7;

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
  | { kind: "capture"; seq: number; action: "keepOut" }
  /** The option picked in a list (a biome, an encounter's follow-up option) */
  | { kind: "option"; seq: number; index: number }
  /** The party slot picked in an encounter; a slot outside the party for none */
  | { kind: "partySelect"; seq: number; slot: number }
  /** The party slot picked for a move's effect (Revival Blessing), a `PartyOption` in `option` */
  | { kind: "partyPick"; seq: number; slotIndex: number; option: number }
  /** The move slot a new move replaces, `-1` if the move was not learned */
  | { kind: "learnMove"; seq: number; moveIndex: number }
  /** Whether the owner stopped an evolution, and whether they paused further evolutions */
  | { kind: "evolution"; seq: number; cancelled: boolean; paused: boolean }
  /**
   * The owner's answer to "switch?" at the start of a wave: the party slot sent out, a slot outside the party to stay.
   * An owner who is not asked (the "Set" battle style) sends a stay too.
   */
  | { kind: "waveStartSwitch"; seq: number; slotIndex: number };

export type CoopDecisionKind = CoopDecision["kind"];

/**
 * Something done on the reward screen that changes the run (spec 3.5).
 * Option numbers index the offered rewards (`reward`) or the wave's shop list, flattened (`shop`).
 * `slot` is the party slot of the target, `partyOption` the party screen option picked with it (a move for PP items),
 * `splice` the second pokemon of a fusion.
 */
export type CoopRewardAction =
  | { kind: "reward"; option: number; slot?: number; partyOption?: number; splice?: number }
  | { kind: "shop"; option: number; slot?: number; partyOption?: number }
  | { kind: "reroll" }
  | { kind: "lock" }
  | { kind: "transfer"; from: number; itemIndex: number; quantity: number; to: number }
  | { kind: "skip" };

/**
 * Where a player's cursor is, for the partner to show (spec 4.7): a species on the starter select grid,
 * or an option on reward screen `gen` (`row` and `cursor` as the reward screen counts them).
 */
export type CoopCursorAt =
  | { screen: "starter"; speciesId: number }
  | { screen: "reward"; gen: number; row: number; cursor: number };

// Payloads below are narrowed by later co-op plans.
export type TurnCommandPayload = CoopTurnCommandPayload;
export type CoopChoiceKind = string;

/** Why a player leaves a co-op run, so the partner can tell the player. */
export type CoopByeReason = "saveAndQuit" | "wrongAccount" | "desync" | "timeout";

/**
 * A message between the two clients. Once connected, every message but `ack` carries `n`, its number in the sender's
 * order (see `ReliableCoopTransport`); the game itself never reads it.
 */
export type CoopMessage = CoopMessageBody & { n?: number };

type CoopMessageBody =
  /**
   * The first message on a new connection. `trainerId` tells accounts apart where every name is the same (offline),
   * `resume` is set by a player continuing a saved run: a host continuing it from the title screen, or the player
   * who stayed in the room when the partner comes back.
   */
  | {
      t: "hello";
      gameVersion: string;
      protocol: number;
      accountName: string;
      trainerId: number;
      resume?: boolean;
    }
  /**
   * A player's starter selection, sent whenever their party or ready changes: `picks` is the party (confirmed while
   * `ready`) and `cost` its starter points, counted on the sender's account.
   * `account` is the sender's account snapshot, read for their pokemon once the run starts.
   */
  | { t: "starters"; picks: CoopStarterPayload[]; ready: boolean; cost: number; account: CoopAccountSnapshot }
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
  /**
   * A choice for the partner's client to apply. Decisions (`CoopDecision` kinds) carry their sequence number in the
   * payload; `ownerAsk` (`{ seq, slot }`) and `optionAsk` (`{ seq, index }`) ask the partner to confirm, and
   * `meOption` (`{ index }`) is the picked encounter option.
   */
  | { t: "choice"; kind: CoopChoiceKind; wave: number; payload: unknown }
  /** A hint for the partner: "pick this one". `row` and `cursor` on the reward screen, `index` in a list. */
  | { t: "ping"; kind: "reward" | "option" | "encounter"; payload: { row?: number; cursor?: number; index?: number } }
  /** Where the sender's cursor is now, `null` while it is on nothing the partner can see. Changes nothing in the run. */
  | { t: "cursor"; at: CoopCursorAt | null }
  | { t: "checksum"; wave: number; turn: number; hash: string }
  /**
   * A reward screen action (spec 3.5, generalizing `shopBuy`). `gen` is the reward screen the requester saw and `req`
   * the requester's own count. The guest requests without `seq`; the host attaches the order in which it took the
   * requests (its own included) and sends the result to both clients, which apply events in `seq` order only.
   */
  | {
      t: "reward";
      wave: number;
      gen: number;
      req: number;
      by: CoopRole;
      action: CoopRewardAction;
      seq?: number;
    }
  /** For `flee`, `turn` is the battle turn of the declined proposal; other kinds echo the asker's `seq`. */
  | {
      t: "confirm";
      kind: "mePokemon" | "meOption" | "flee";
      wave: number;
      turn?: number;
      seq?: number;
      accepted: boolean;
    }
  /**
   * Sent by the player continuing a saved run: the saved session (JSON, `coop` block included) both clients load.
   * `role` is the receiver's role in that run (default `guest`).
   */
  | { t: "resume"; session: string; role?: CoopRole }
  | { t: "bye"; reason?: CoopByeReason }
  /** Every message numbered up to `n` has arrived; the sender need not resend them. */
  | { t: "ack"; n: number };

const COOP_MESSAGE_KINDS = [
  "hello",
  "starters",
  "start",
  "turnCommand",
  "choice",
  "ping",
  "cursor",
  "checksum",
  "reward",
  "confirm",
  "resume",
  "bye",
  "ack",
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
