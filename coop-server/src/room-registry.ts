// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

import type { RelaySlot } from "./relay-protocol.ts";

/** No 0/O or 1/I: they look alike in the game font. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;
/** A room nobody joined is dropped after this long. */
const UNJOINED_ROOM_TTL_MS = 10 * 60_000;
/** A player who dropped can rejoin their slot for this long. */
const VACATED_SLOT_TTL_MS = 60_000;

interface Slot {
  present: boolean;
  /** When the slot was last vacated, or `null` if it never was. */
  vacatedAt: number | null;
}

interface Room {
  createdAt: number;
  host: Slot;
  guest: Slot;
  guestEverJoined: boolean;
}

export type JoinResult = "ok" | "notFound" | "full";

/** Tracks rooms and who is in them. Holds no sockets, so it can be tested with an injected clock. */
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
    this.rooms.set(code, {
      createdAt: this.now(),
      host: { present: true, vacatedAt: null },
      guest: { present: false, vacatedAt: null },
      guestEverJoined: false,
    });
    return code;
  }

  join(code: string, slot: RelaySlot = "guest"): JoinResult {
    const room = this.rooms.get(code);
    if (!room) {
      return "notFound";
    }
    if (room[slot].present) {
      return "full";
    }
    room[slot] = { present: true, vacatedAt: null };
    if (slot === "guest") {
      room.guestEverJoined = true;
    }
    return "ok";
  }

  leave(code: string, slot: RelaySlot): void {
    const room = this.rooms.get(code);
    if (room?.[slot].present) {
      room[slot] = { present: false, vacatedAt: this.now() };
    }
  }

  /** Remove expired rooms. @returns The codes that were removed */
  sweep(): string[] {
    const now = this.now();
    const expired: string[] = [];
    for (const [code, room] of this.rooms) {
      if (this.isExpired(room, now)) {
        this.rooms.delete(code);
        expired.push(code);
      }
    }
    return expired;
  }

  private isExpired(room: Room, now: number): boolean {
    if (!room.host.present && !room.guest.present) {
      return true;
    }
    if (!room.guestEverJoined && now - room.createdAt >= UNJOINED_ROOM_TTL_MS) {
      return true;
    }
    return [room.host, room.guest].some(
      slot => !slot.present && slot.vacatedAt !== null && now - slot.vacatedAt >= VACATED_SLOT_TTL_MS,
    );
  }

  private generateCode(): string {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(this.random() * CODE_ALPHABET.length)];
    }
    return code;
  }
}
