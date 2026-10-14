import { coopRandInt, coopRandIntRange } from "#coop/coop-random";
import { CoopSession, setCoopSession } from "#coop/coop-session";
import { createLoopbackPair } from "#coop/loopback-transport";
import { randSeedInt, randSeedIntRange } from "#utils/common";
import Phaser from "phaser";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("coop-random", () => {
  beforeAll(() => {
    // Creating a game sets up `Phaser.Math.RND`.
    new Phaser.Game({ type: Phaser.HEADLESS });
  });

  afterEach(() => {
    setCoopSession(null);
    vi.restoreAllMocks();
  });

  it("matches randInt outside co-op", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.75);
    Phaser.Math.RND.sow(["solo"]);
    const stateBefore = Phaser.Math.RND.state();

    expect(coopRandInt(4)).toBe(3);
    expect(coopRandInt(4, 10)).toBe(13);
    expect(coopRandIntRange(1, 6)).toBe(5);
    expect(Phaser.Math.RND.state()).toBe(stateBefore);
  });

  it("uses the seeded RNG in co-op", () => {
    setCoopSession(new CoopSession("guest", createLoopbackPair().guest));
    const random = vi.spyOn(Math, "random");

    Phaser.Math.RND.sow(["coop"]);
    const actual = [coopRandInt(4), coopRandInt(100, 5), coopRandIntRange(1, 6), coopRandIntRange(0, 1)];

    Phaser.Math.RND.sow(["coop"]);
    const expected = [randSeedInt(4), randSeedInt(100, 5), randSeedIntRange(1, 6), randSeedIntRange(0, 1)];

    expect(actual).toEqual(expected);
    expect(random).not.toHaveBeenCalled();
  });
});
