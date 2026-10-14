// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

import type { RelaySlot } from "./relay-protocol.ts";

/** No 0/O or 1/I: they look alike in the game font. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** A room nobody is in is dropped after this long, so players who all dropped at once can still rejoin. */
const EMPTY_ROOM_TTL_MS = 60_000;

interface Room {
  present: Record<RelaySlot, boolean>;
  /** When the last player left, or `null` while someone is in the room. */
  emptySince: number | null;
}

/** The slot a join took, or why it failed. */
export type JoinResult = RelaySlot | "notFound" | "full";

/**
 * Tracks rooms and who is in them. Holds no sockets, so it can be tested with an injected clock.
 * A room stays open as long as one player is in it: whoever stays can wait for the partner to come back.
 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(now: () => number = Date.now, random: () => number = Math.random) {
    this.now = now;
    this.random = random;
  }

  /** Create a room with the host already in it. */
  createRoom(): string {
    let code: string;
    do {
      code = this.generateCode();
    } while (this.rooms.has(code));
    this.rooms.set(code, { present: { host: true, guest: false }, emptySince: null });
    return code;
  }

  /**
   * Take a slot in a room.
   * @param slot - The slot to take back after a dropped connection; omitted, the guest slot or else the host slot
   */
  join(code: string, slot?: RelaySlot): JoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return "notFound";
    }
    const taken = slot ?? (room.present.guest ? "host" : "guest");
    if (room.present[taken]) {
      return "full";
    }
    room.present[taken] = true;
    room.emptySince = null;
    return taken;
  }

  leave(code: string, slot: RelaySlot): void {
    const room = this.rooms.get(code);
    if (!room?.present[slot]) {
      return;
    }
    room.present[slot] = false;
    if (!room.present.host && !room.present.guest) {
      room.emptySince = this.now();
    }
  }

  /** Remove rooms nobody came back to. @returns The codes that were removed */
  sweep(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince >= EMPTY_ROOM_TTL_MS) {
        this.rooms.delete(code);
        expired.push(code);
      }
    }
    return expired;
  }

  private generateCode(): string {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
    }
    return code;
  }
}
