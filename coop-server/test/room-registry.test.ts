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
    assert.equal(registry.join(code), "ok");
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

  it("expires an unjoined room after ten minutes", () => {
    const clock = createClock();
    const registry = new RoomRegistry(clock.now);
    const code = registry.createRoom();
    clock.advance(599_999);
    assert.deepEqual(registry.sweep(), []);
    clock.advance(1);
    assert.deepEqual(registry.sweep(), [code]);
    assert.equal(registry.join(code), "notFound");
  });

  it("keeps a vacated slot for sixty seconds", () => {
    const clock = createClock();
    const registry = new RoomRegistry(clock.now);
    const kept = registry.createRoom();
    registry.join(kept);
    registry.leave(kept, "guest");
    clock.advance(59_999);
    assert.deepEqual(registry.sweep(), []);
    assert.equal(registry.join(kept, "guest"), "ok");

    const dropped = registry.createRoom();
    registry.join(dropped);
    registry.leave(dropped, "guest");
    clock.advance(60_000);
    assert.deepEqual(registry.sweep(), [dropped]);
  });

  it("does not expire a paired room", () => {
    const clock = createClock();
    const registry = new RoomRegistry(clock.now);
    const code = registry.createRoom();
    registry.join(code);
    clock.advance(60 * 60_000);
    assert.deepEqual(registry.sweep(), []);
  });

  it("removes a room immediately once both players leave", () => {
    const registry = new RoomRegistry();
    const code = registry.createRoom();
    registry.join(code);
    registry.leave(code, "guest");
    registry.leave(code, "host");
    assert.deepEqual(registry.sweep(), [code]);
  });
});
