/**
 * Wire protocol for co-op play: message types, protocol version and join code helpers.
 * @module
 */

/** Bumped whenever a message shape changes incompatibly. Peers with different versions refuse to connect. */
export const COOP_PROTOCOL_VERSION = 1;

export type CoopRole = "host" | "guest";

// Payloads below are narrowed by later co-op plans.
export type CoopStarterPayload = Record<string, unknown>;
export type TurnCommandPayload = Record<string, unknown>;
export type CoopWorldData = Record<string, unknown>;
export type CoopSessionSnapshot = Record<string, unknown>;
export type CoopChoiceKind = string;

export type CoopMessage =
  | { t: "hello"; gameVersion: string; protocol: number; accountName: string }
  | { t: "starters"; picks: CoopStarterPayload[]; ready: boolean }
  /** Sent by the host only. Carries a snapshot of the host's world-level account data. */
  | { t: "start"; seed: string; hostWorldData: CoopWorldData }
  | { t: "turnCommand"; turn: number; wave: number; command: TurnCommandPayload }
  | { t: "choice"; kind: CoopChoiceKind; wave: number; payload: unknown }
  | { t: "ping"; kind: CoopChoiceKind; payload: unknown }
  | { t: "checksum"; wave: number; turn: number; hash: string }
  /** The guest requests without `seq`; the host confirms by attaching one. */
  | { t: "shopBuy"; wave: number; seq?: number; option: number; target: number }
  | { t: "confirm"; kind: "mePokemon" | "meOption" | "flee"; wave: number; accepted: boolean }
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
