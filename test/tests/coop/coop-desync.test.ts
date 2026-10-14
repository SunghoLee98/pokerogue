import { type CoopChecksum, findFirstDesync } from "#coop/coop-desync";
import { describe, expect, it } from "vitest";

const sequence: CoopChecksum[] = [
  { wave: 1, turn: 1, hash: "a" },
  { wave: 1, turn: 2, hash: "b" },
  { wave: 2, turn: 0, hash: "c" },
];

describe("findFirstDesync", () => {
  it("returns null for identical sequences", () => {
    expect(
      findFirstDesync(
        sequence,
        sequence.map(c => ({ ...c })),
      ),
    ).toBeNull();
    expect(findFirstDesync([], [])).toBeNull();
  });

  it("reports the first differing checkpoint", () => {
    const actual = sequence.map(c => ({ ...c }));
    actual[1].hash = "x";
    actual[2].hash = "y";
    expect(findFirstDesync(sequence, actual)).toEqual({ index: 1, expected: sequence[1], actual: actual[1] });

    const shifted = sequence.map(c => ({ ...c }));
    shifted[0].turn = 9;
    expect(findFirstDesync(sequence, shifted)?.index).toBe(0);
  });

  it("reports a missing checkpoint when lengths differ", () => {
    expect(findFirstDesync(sequence, sequence.slice(0, 2))).toEqual({
      index: 2,
      expected: sequence[2],
      actual: undefined,
    });
    expect(findFirstDesync(sequence.slice(0, 1), sequence)).toEqual({
      index: 1,
      expected: undefined,
      actual: sequence[1],
    });
  });
});
