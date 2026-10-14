// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
// biome-ignore lint/style/noRestrictedImports: the relay server is a separate Node runtime without vitest
import { describe, it } from "node:test";
import { RoomRegistry } from "../src/room-registry.ts";

function createClock() {
  let time = 1_000_000;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("RoomRegistry", () => {
  it("creates unique six-character codes", () => {
    const registry = new RoomRegistry();
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const code = registry.createRoom();
      assert.match(code, /^[A-Z0-9]{6}$/);
      codes.add(code);
    }
    assert.equal(codes.size, 100);
  });

  it("never uses characters that look alike in the game font", () => {
    const registry = new RoomRegistry();
    for (let i = 0; i < 500; i++) {
      assert.doesNotMatch(registry.createRoom(), /[0O1I]/);
    }
  });

  it("retries when a generated code is already taken", () => {
    // The first two codes are identical, so the second room must draw again.
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    const registry = new RoomRegistry(Date.now, () => values.shift() ?? 0.9);
    const first = registry.createRoom();
    const second = registry.createRoom();
    assert.equal(first, "AAAAAA");
    assert.notEqual(second, first);
  });

  it("lets a guest join once", () => {
    const registry = new RoomRegistry();
    const code = registry.createRoom();
    assert.equal(registry.join(code), "guest");
  });

  it("rejects a third client", () => {
    const registry = new RoomRegistry();
    const code = registry.createRoom();
    registry.join(code);
    assert.equal(registry.join(code), "full");
    assert.equal(registry.join(code, "host"), "full");
  });

  it("rejects an unknown code", () => {
    const registry = new RoomRegistry();
    assert.equal(registry.join("ZZZZZZ"), "notFound");
  });

  it("gives a plain join the host slot when only the guest stayed", () => {
    const registry = new RoomRegistry();
    const code = registry.createRoom();
    registry.join(code);
    registry.leave(code, "host");
    assert.equal(registry.join(code), "host");
  });

  it("lets a player take back their own slot", () => {
    const registry = new RoomRegistry();
    const code = registry.createRoom();
    registry.join(code);
    registry.leave(code, "guest");
    assert.equal(registry.join(code, "host"), "full");
    assert.equal(registry.join(code, "guest"), "guest");
  });

  it("keeps a room open as long as one player is in it", () => {
    const clock = createClock();
    const registry = new RoomRegistry(clock.now);
    const waiting = registry.createRoom();
    const left = registry.createRoom();
    registry.join(left);
    registry.leave(left, "guest");
    clock.advance(60 * 60_000);
    assert.deepEqual(registry.sweep(), []);
    assert.equal(registry.join(waiting), "guest");
    assert.equal(registry.join(left), "guest");
  });

  it("keeps an empty room for sixty seconds", () => {
    const clock = createClock();
    const registry = new RoomRegistry(clock.now);
    const code = registry.createRoom();
    registry.join(code);
    registry.leave(code, "guest");
    registry.leave(code, "host");
    clock.advance(59_999);
    assert.deepEqual(registry.sweep(), []);
    assert.equal(registry.join(code, "host"), "host");
    registry.leave(code, "host");
    clock.advance(60_000);
    assert.deepEqual(registry.sweep(), [code]);
    assert.equal(registry.join(code), "notFound");
  });
});
