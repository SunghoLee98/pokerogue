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
  | { t: "relay:paired" }
  | { t: "relay:peerLeft" }
  | { t: "relay:error"; reason: RelayErrorReason };
