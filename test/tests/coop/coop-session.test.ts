import { COOP_MAX_OWNED, CoopOwnership } from "#coop/coop-ownership";
import { CoopSession, coopSession, setCoopSession } from "#coop/coop-session";
import { createLoopbackPair } from "#coop/loopback-transport";
import { afterEach, describe, expect, it } from "vitest";

describe("CoopOwnership", () => {
  it("allows three pokemon per player", () => {
    expect(COOP_MAX_OWNED).toBe(3);
  });

  it("records, reads and removes owners", () => {
    const ownership = new CoopOwnership();
    ownership.set(1, "host");
    ownership.set(2, "guest");
    expect(ownership.get(1)).toBe("host");
    expect(ownership.get(2)).toBe("guest");
    expect(ownership.get(3)).toBeUndefined();
    ownership.remove(1);
    expect(ownership.get(1)).toBeUndefined();
  });

  it("counts only owned pokemon still in the party", () => {
    const ownership = new CoopOwnership();
    for (const id of [1, 2, 3]) {
      ownership.set(id, "host");
    }
    ownership.set(4, "guest");
    expect(ownership.countOwnedBy("host", [1, 2, 4])).toBe(2);
    expect(ownership.countOwnedBy("guest", [1, 2, 4])).toBe(1);
  });

  it("round-trips ownership through JSON", () => {
    const ownership = new CoopOwnership();
    ownership.set(1, "host");
    ownership.set(4, "guest");
    const restored = CoopOwnership.fromJSON(JSON.parse(JSON.stringify(ownership)));
    expect(restored.get(4)).toBe("guest");
    expect(restored.get(1)).toBe("host");
    expect(restored.toJSON()).toEqual({ 1: "host", 4: "guest" });
  });
});

describe("CoopSession", () => {
  afterEach(() => {
    setCoopSession(null);
  });

  const createSession = (role: "host" | "guest") => new CoopSession(role, createLoopbackPair().host);

  it("knows the remote role", () => {
    expect(createSession("host").remoteRole).toBe("guest");
    expect(createSession("guest").remoteRole).toBe("host");
  });

  it("alternates the reward picker by wave", () => {
    const session = createSession("host");
    expect(session.pickerForWave(1)).toBe("host");
    expect(session.pickerForWave(2)).toBe("guest");
    expect(session.pickerForWave(3)).toBe("host");
    expect(session.pickerForWave(200)).toBe("guest");
  });

  it("tells whether the local player picks", () => {
    expect(createSession("host").isLocalPicker(1)).toBe(true);
    expect(createSession("host").isLocalPicker(2)).toBe(false);
    expect(createSession("guest").isLocalPicker(2)).toBe(true);
  });

  it("tells whether a pokemon is locally owned", () => {
    const session = createSession("guest");
    session.ownership.set(1, "host");
    session.ownership.set(2, "guest");
    expect(session.isLocallyOwned(1)).toBe(false);
    expect(session.isLocallyOwned(2)).toBe(true);
    expect(session.isLocallyOwned(3)).toBe(false);
  });

  it("exposes the session globally", () => {
    expect(coopSession).toBeNull();
    const session = createSession("host");
    setCoopSession(session);
    expect(coopSession).toBe(session);
    setCoopSession(null);
    expect(coopSession).toBeNull();
  });
});
