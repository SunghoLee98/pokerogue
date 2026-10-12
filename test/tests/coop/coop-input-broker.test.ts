import { CoopInputBroker, type CoopTurnMessage } from "#coop/coop-input-broker";
import type { CoopMessage, CoopTurnCommandPayload } from "#coop/coop-protocol";
import { CoopSession } from "#coop/coop-session";
import type { CoopTransport } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { Command } from "#enums/command";
import { describe, expect, it } from "vitest";

function command(fieldIndex: number, kind: Command = Command.FIGHT): CoopTurnCommandPayload {
  return { fieldIndex, turnCommand: { command: kind, cursor: 0 }, preTurnCommand: null };
}

function turnCommand(wave: number, turn: number, fieldIndex: number, kind: Command = Command.FIGHT): CoopMessage {
  return { t: "turnCommand", wave, turn, command: command(fieldIndex, kind) };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function connect(): { broker: CoopInputBroker; peer: CoopTransport } {
  const { host, guest } = createLoopbackPair();
  return { broker: new CoopInputBroker(host), peer: guest };
}

const isCommandFor =
  (fieldIndex: number) =>
  (message: CoopTurnMessage): boolean =>
    message.t === "turnCommand" && message.command.fieldIndex === fieldIndex;

describe("CoopInputBroker", () => {
  it("keeps turn messages per turn in arrival order", async () => {
    const { broker, peer } = connect();
    peer.send(turnCommand(1, 2, 1));
    peer.send({ t: "confirm", kind: "flee", wave: 1, turn: 2, accepted: false });
    peer.send(turnCommand(1, 3, 1));
    await flush();

    expect(broker.peekTurnMessages(1, 2).map(m => m.t)).toEqual(["turnCommand", "confirm"]);
    expect(broker.peekTurnMessages(1, 3)).toHaveLength(1);
    expect(broker.takeTurnMessage(1, 2, m => m.t === "confirm")?.t).toBe("confirm");
    expect(broker.peekTurnMessages(1, 2).map(m => m.t)).toEqual(["turnCommand"]);
  });

  it("hands a waiting reader the next matching message", async () => {
    const { broker, peer } = connect();
    const waiting = broker.waitTurnMessage(4, 1, isCommandFor(0));
    peer.send(turnCommand(4, 1, 1));
    peer.send(turnCommand(4, 1, 0, Command.RUN));
    const received = await waiting;

    expect(received).toEqual(turnCommand(4, 1, 0, Command.RUN));
    // The non-matching message stays for another reader.
    expect(broker.peekTurnMessages(4, 1)).toEqual([turnCommand(4, 1, 1)]);
  });

  it("returns an already received message right away", async () => {
    const { broker, peer } = connect();
    peer.send(turnCommand(1, 1, 1));
    await flush();
    await expect(broker.waitTurnMessage(1, 1, isCommandFor(1))).resolves.toEqual(turnCommand(1, 1, 1));
    expect(broker.peekTurnMessages(1, 1)).toEqual([]);
  });

  it("puts a message back at the front", async () => {
    const { broker, peer } = connect();
    peer.send(turnCommand(1, 1, 1, Command.BALL));
    await flush();
    const taken = broker.takeTurnMessage(1, 1, isCommandFor(1));
    peer.send(turnCommand(1, 1, 1, Command.RUN));
    await flush();
    broker.putBackTurnMessage(taken!);
    expect(broker.peekTurnMessages(1, 1).map(m => m.t === "turnCommand" && m.command.turnCommand.command)).toEqual([
      Command.BALL,
      Command.RUN,
    ]);
  });

  it("delivers decisions by sequence even if they arrive early", async () => {
    const { broker, peer } = connect();
    peer.send({ t: "choice", kind: "switch", wave: 1, payload: { kind: "switch", seq: 1, slotIndex: 3, option: 0 } });
    peer.send({ t: "choice", kind: "capture", wave: 1, payload: { kind: "capture", seq: 0, action: "keepOut" } });
    await flush();

    await expect(broker.waitDecision(0)).resolves.toEqual({ kind: "capture", seq: 0, action: "keepOut" });
    await expect(broker.waitDecision(1)).resolves.toEqual({ kind: "switch", seq: 1, slotIndex: 3, option: 0 });
  });

  it("waits for a decision that has not arrived", async () => {
    const { broker, peer } = connect();
    const waiting = broker.waitDecision(5);
    peer.send({ t: "choice", kind: "switch", wave: 2, payload: { kind: "switch", seq: 5, slotIndex: 2, option: 1 } });
    await expect(waiting).resolves.toMatchObject({ seq: 5, slotIndex: 2 });
  });

  it("notifies turn message arrivals", async () => {
    const { broker, peer } = connect();
    const seen: CoopTurnMessage[] = [];
    const off = broker.onTurnMessage(m => seen.push(m));
    peer.send(turnCommand(1, 1, 1, Command.RUN));
    await flush();
    off();
    peer.send(turnCommand(1, 2, 1));
    await flush();
    expect(seen).toEqual([turnCommand(1, 1, 1, Command.RUN)]);
  });

  it("sends through the transport", async () => {
    const { broker, peer } = connect();
    const received: CoopMessage[] = [];
    peer.onMessage(m => received.push(m));
    broker.send(turnCommand(1, 1, 0));
    await flush();
    expect(received).toEqual([turnCommand(1, 1, 0)]);
  });

  it("stops delivering after dispose", async () => {
    const { broker, peer } = connect();
    broker.dispose();
    peer.send(turnCommand(1, 1, 1));
    await flush();
    expect(broker.peekTurnMessages(1, 1)).toEqual([]);
  });

  it("belongs to the session and numbers decisions", () => {
    const session = new CoopSession("host", createLoopbackPair().host);
    expect(session.inputs).toBeInstanceOf(CoopInputBroker);
    expect([session.nextDecisionSeq(), session.nextDecisionSeq(), session.nextDecisionSeq()]).toEqual([0, 1, 2]);
  });
});
