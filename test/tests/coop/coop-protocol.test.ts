import {
  COOP_PROTOCOL_VERSION,
  type CoopMessage,
  decodeCoopMessage,
  encodeCoopMessage,
  normalizeJoinCode,
} from "#coop/coop-protocol";
import { describe, expect, it } from "vitest";

const account = { trainerId: 1, secretId: 2, caughtSpecies: [1], eggMoves: { 1: 3 }, unlocks: [0] };
const pick = {
  speciesId: 1,
  formIndex: 0,
  gender: 1,
  shiny: true,
  variant: 2,
  abilityIndex: 0,
  passive: false,
  nature: 3,
  ivs: [31, 31, 31, 31, 31, 31],
  moveset: [33, 45],
  teraType: 11,
  friendship: 50,
  pokeball: 0,
  nickname: "Bulby",
  pokerus: false,
  luck: 3,
} satisfies Extract<CoopMessage, { t: "starters" }>["picks"][number];

describe("coop-protocol", () => {
  it("round-trips every message kind", () => {
    const messages: CoopMessage[] = [
      { t: "hello", gameVersion: "1.12.1.0", protocol: COOP_PROTOCOL_VERSION, accountName: "a" },
      { t: "starters", picks: [pick], ready: true, account },
      {
        t: "start",
        seed: "seed",
        hostWorldData: account,
        guestAccount: { ...account, trainerId: 9 },
        hostPicks: [pick],
        guestPicks: [{ ...pick, speciesId: 4 }],
        timedEvent: null,
      },
      { t: "turnCommand", turn: 1, wave: 2, command: { move: 0 } },
      { t: "choice", kind: "reward", wave: 2, payload: 1 },
      { t: "ping", kind: "reward", payload: null },
      { t: "checksum", wave: 2, turn: 1, hash: "abc" },
      { t: "shopBuy", wave: 3, option: 1, target: 4 },
      { t: "shopBuy", wave: 3, seq: 2, option: 1, target: 4 },
      { t: "confirm", kind: "flee", wave: 7, accepted: false },
      { t: "resume", session: {} },
      { t: "bye" },
    ];
    for (const m of messages) {
      expect(decodeCoopMessage(encodeCoopMessage(m))).toEqual(m);
    }
  });

  it("returns null for malformed input", () => {
    expect(decodeCoopMessage("not json")).toBeNull();
    expect(decodeCoopMessage("[]")).toBeNull();
    expect(decodeCoopMessage("null")).toBeNull();
    expect(decodeCoopMessage('{"t":"nope"}')).toBeNull();
    expect(decodeCoopMessage('{"t":"relay:paired"}')).toBeNull();
  });

  it("normalizes join codes", () => {
    expect(normalizeJoinCode(" ab-c1 23 ")).toBe("ABC123");
    expect(normalizeJoinCode("ABC12")).toBeNull();
    expect(normalizeJoinCode("ABC1234")).toBeNull();
    expect(normalizeJoinCode("ABC12!")).toBeNull();
  });
});
