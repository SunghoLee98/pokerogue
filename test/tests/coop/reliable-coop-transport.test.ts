import type { CoopMessage } from "#coop/coop-protocol";
import { createLoopbackPair, type LoopbackTransport } from "#coop/loopback-transport";
import { ReliableCoopTransport } from "#coop/reliable-coop-transport";
import { describe, expect, it } from "vitest";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const checksum = (turn: number): CoopMessage => ({ t: "checksum", wave: 1, turn, hash: `h${turn}` });

async function connectedPair() {
  const pair = createLoopbackPair();
  const { joinCode } = await pair.host.host();
  await pair.guest.join(joinCode);
  return pair;
}

/** A wrapped host and a wrapped guest, with what each one's game receives. */
async function reliablePair() {
  const pair = await connectedPair();
  const host = new ReliableCoopTransport(pair.host);
  const guest = new ReliableCoopTransport(pair.guest);
  const received = { host: [] as CoopMessage[], guest: [] as CoopMessage[] };
  host.onMessage(m => received.host.push(m));
  guest.onMessage(m => received.guest.push(m));
  return { pair, host, guest, received };
}

/** Record the raw frames a loopback end receives. */
function rawFrames(transport: LoopbackTransport): CoopMessage[] {
  const frames: CoopMessage[] = [];
  transport.onMessage(m => frames.push(m));
  return frames;
}

describe("ReliableCoopTransport", () => {
  it("delivers messages without their numbers", async () => {
    const { host, received } = await reliablePair();
    host.send(checksum(1));
    host.send({ t: "bye" });
    await flush();
    expect(received.guest).toEqual([checksum(1), { t: "bye" }]);
  });

  it("delivers what was sent while disconnected once the connection is back, once and in order", async () => {
    const { pair, host, guest, received } = await reliablePair();
    host.send(checksum(1));
    await flush();

    pair.drop();
    host.send(checksum(2));
    guest.send(checksum(10));
    host.send(checksum(3));
    await flush();
    expect(received.guest).toEqual([checksum(1)]);
    expect(host.status).toBe("reconnecting");

    pair.restore();
    host.send(checksum(4));
    await flush();

    expect(host.status).toBe("connected");
    expect(received.guest).toEqual([checksum(1), checksum(2), checksum(3), checksum(4)]);
    expect(received.host).toEqual([checksum(10)]);
  });

  it("drops a message that arrives twice", async () => {
    const pair = await connectedPair();
    const guest = new ReliableCoopTransport(pair.guest);
    const received: CoopMessage[] = [];
    guest.onMessage(m => received.push(m));

    pair.host.send({ ...checksum(1), n: 1 });
    pair.host.send({ ...checksum(1), n: 1 });
    pair.host.send({ ...checksum(2), n: 2 });
    await flush();

    expect(received).toEqual([checksum(1), checksum(2)]);
  });

  it("puts messages that arrive out of order back in order", async () => {
    const pair = await connectedPair();
    const guest = new ReliableCoopTransport(pair.guest);
    const received: CoopMessage[] = [];
    guest.onMessage(m => received.push(m));

    pair.host.send({ ...checksum(3), n: 3 });
    pair.host.send({ ...checksum(1), n: 1 });
    await flush();
    expect(received).toEqual([checksum(1)]);
    pair.host.send({ ...checksum(2), n: 2 });
    await flush();

    expect(received).toEqual([checksum(1), checksum(2), checksum(3)]);
  });

  it("passes on messages without a number", async () => {
    const pair = await connectedPair();
    const guest = new ReliableCoopTransport(pair.guest);
    const received: CoopMessage[] = [];
    guest.onMessage(m => received.push(m));
    pair.host.send(checksum(1));
    await flush();
    expect(received).toEqual([checksum(1)]);
  });

  it("does not resend what the partner confirmed", async () => {
    const pair = await connectedPair();
    const host = new ReliableCoopTransport(pair.host);
    const guest = new ReliableCoopTransport(pair.guest);
    guest.onMessage(() => {});
    for (let turn = 1; turn <= 20; turn++) {
      host.send(checksum(turn));
    }
    await flush();
    const frames = rawFrames(pair.guest);

    pair.drop();
    pair.restore();
    await flush();

    // 16 were confirmed; only 17-20 come again.
    expect(frames.filter(f => f.t === "checksum").map(f => f.n)).toEqual([17, 18, 19, 20]);
  });

  it("hands the connection over once released", async () => {
    const { pair, host, received } = await reliablePair();
    const frames = rawFrames(pair.guest);
    const inner = host.release();
    expect(inner).toBe(pair.host);

    host.send(checksum(1));
    host.close();
    pair.guest.send({ t: "bye" });
    await flush();

    expect(frames).toEqual([]);
    expect(received.host).toEqual([]);
    expect(pair.host.status).toBe("connected");
    // What arrives now waits for whoever listens to the connection next.
    const next: CoopMessage[] = [];
    pair.host.onMessage(m => next.push(m));
    expect(next).toEqual([{ t: "bye" }]);
  });

  it("reports the connection's status", async () => {
    const { pair, host } = await reliablePair();
    const statuses: string[] = [];
    host.onStatusChange(status => statuses.push(status));
    pair.drop();
    pair.restore();
    host.close();
    expect(statuses).toEqual(["reconnecting", "connected", "closed"]);
  });
});
