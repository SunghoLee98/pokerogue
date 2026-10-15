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
      { t: "hello", gameVersion: "1.12.1.0", protocol: COOP_PROTOCOL_VERSION, accountName: "a", trainerId: 5 },
      { t: "hello", gameVersion: "1.12.1.0", protocol: 4, accountName: "a", trainerId: 5, resume: true },
      { t: "starters", picks: [pick], ready: true, cost: 3, account },
      {
        t: "start",
        seed: "seed",
        hostWorldData: account,
        guestAccount: { ...account, trainerId: 9 },
        hostPicks: [pick],
        guestPicks: [{ ...pick, speciesId: 4 }],
        timedEvent: null,
      },
      {
        t: "turnCommand",
        turn: 1,
        wave: 2,
        command: {
          fieldIndex: 1,
          turnCommand: { command: 0, cursor: 0, move: { move: 33, targets: [], useMode: 0 }, targets: [2] },
          preTurnCommand: { command: 0, targets: [1], skip: true },
        },
      },
      {
        t: "turnCommand",
        turn: 1,
        wave: 2,
        command: { fieldIndex: 0, turnCommand: { command: 3 }, preTurnCommand: null },
      },
      { t: "choice", kind: "switch", wave: 2, payload: { kind: "switch", seq: 0, slotIndex: 3, option: 0 } },
      {
        t: "choice",
        kind: "capture",
        wave: 2,
        payload: { kind: "capture", seq: 1, action: "replace", releasedId: 7, insertIndex: 2 },
      },
      { t: "ping", kind: "reward", payload: { row: 1, cursor: 0 } },
      { t: "cursor", at: { screen: "starter", speciesId: 1 } },
      { t: "cursor", at: null },
      { t: "checksum", wave: 2, turn: 1, hash: "abc" },
      { t: "reward", wave: 3, gen: 1, req: 0, by: "guest", action: { kind: "shop", option: 1, slot: 4 } },
      {
        t: "reward",
        wave: 3,
        gen: 1,
        req: 0,
        by: "guest",
        seq: 2,
        action: { kind: "reward", option: 0, slot: 1, partyOption: 4 },
      },
      { t: "reward", wave: 3, gen: 2, req: 1, by: "host", seq: 3, action: { kind: "reroll" } },
      {
        t: "reward",
        wave: 3,
        gen: 2,
        req: 2,
        by: "host",
        seq: 4,
        action: { kind: "transfer", from: 0, itemIndex: 1, quantity: 1, to: 3 },
      },
      { t: "choice", kind: "option", wave: 3, payload: { kind: "option", seq: 4, index: 1 } },
      {
        t: "choice",
        kind: "evolution",
        wave: 3,
        payload: { kind: "evolution", seq: 5, cancelled: true, paused: false },
      },
      { t: "choice", kind: "ownerAsk", wave: 3, payload: { seq: 6, slot: 3 } },
      { t: "choice", kind: "meOption", wave: 3, payload: { index: 1 } },
      { t: "confirm", kind: "flee", wave: 7, turn: 2, accepted: false },
      { t: "confirm", kind: "mePokemon", wave: 7, seq: 6, accepted: true },
      { t: "resume", session: '{"seed":"s","coop":{}}' },
      { t: "bye" },
      { t: "bye", reason: "saveAndQuit" },
      { t: "bye", reason: "wrongAccount" },
      { t: "ack", n: 16 },
      {
        t: "turnCommand",
        turn: 1,
        wave: 2,
        n: 3,
        command: { fieldIndex: 0, turnCommand: { command: 3 }, preTurnCommand: null },
      },
    ];
    for (const m of messages) {
      expect(decodeCoopMessage(encodeCoopMessage(m))).toEqual(m);
    }
  });

  it("is protocol 7", () => {
    expect(COOP_PROTOCOL_VERSION).toBe(7);
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
