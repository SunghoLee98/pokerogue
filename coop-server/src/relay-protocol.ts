// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

// Keep in sync with the copy in src/coop/relay-websocket-transport.ts.
// The server runs outside the game's tsconfig, so the types are duplicated instead of imported.

/** Control frames start with this prefix; every other frame is forwarded to the peer untouched. */
export const RELAY_PREFIX = "relay:";

export type RelaySlot = "host" | "guest";

export type RelayErrorReason = "notFound" | "full" | "badRequest";

export type RelayControlMessage =
  | { t: "relay:code"; code: string }
  /** Sent to a client that took the host slot with a plain join (the host had left); otherwise the slot is the role. */
  | { t: "relay:slot"; slot: RelaySlot }
  /**
   * Both players are in the room. `fresh` tells the player who stayed that a new client took the partner's place
   * (a page that was reloaded or closed), not the same client coming back after a dropped connection.
   */
  | { t: "relay:paired"; fresh?: true }
  | { t: "relay:peerLeft" }
  /** Sent to a client that took back its slot while the partner is away, so it stops retrying. */
  | { t: "relay:waiting" }
  | { t: "relay:error"; reason: RelayErrorReason };
