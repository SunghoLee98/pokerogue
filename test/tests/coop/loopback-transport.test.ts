import { COOP_PROTOCOL_VERSION, type CoopMessage } from "#coop/coop-protocol";
import type { CoopConnectionStatus } from "#coop/coop-transport";
import { createLoopbackPair } from "#coop/loopback-transport";
import { describe, expect, it } from "vitest";

function hello(accountName: string): CoopMessage {
  return { t: "hello", gameVersion: "1.0.0", protocol: COOP_PROTOCOL_VERSION, accountName };
}

/** Let queued microtasks (message delivery) run. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function connectedPair() {
  const pair = createLoopbackPair();
  const { joinCode } = await pair.host.host();
  await pair.guest.join(joinCode);
  return pair;
}

describe("LoopbackTransport", () => {
  it("connects both sides with the loopback code", async () => {
    const { host, guest } = createLoopbackPair();
    const hostStatuses: CoopConnectionStatus[] = [];
    const guestStatuses: CoopConnectionStatus[] = [];
    host.onStatusChange(s => hostStatuses.push(s));
    guest.onStatusChange(s => guestStatuses.push(s));

    await expect(host.host()).resolves.toEqual({ joinCode: "LOOP00" });
    await guest.join("LOOP00");

    expect(hostStatuses.at(-1)).toBe("connected");
    expect(guestStatuses.at(-1)).toBe("connected");
  });

  it("delivers messages both ways in order", async () => {
    const { host, guest } = await connectedPair();
    const guestReceived: CoopMessage[] = [];
    const hostReceived: CoopMessage[] = [];
    guest.onMessage(m => guestReceived.push(m));
    host.onMessage(m => hostReceived.push(m));

    host.send(hello("first"));
    host.send(hello("second"));
    host.send({ t: "bye" });
    guest.send(hello("guest"));
    expect(guestReceived).toEqual([]); // not delivered synchronously
    await flush();

    expect(guestReceived).toEqual([hello("first"), hello("second"), { t: "bye" }]);
    expect(hostReceived).toEqual([hello("guest")]);
  });

  it("buffers messages until the first handler subscribes", async () => {
    const { host, guest } = await connectedPair();
    host.send(hello("early"));
    await flush();

    const received: CoopMessage[] = [];
    guest.onMessage(m => received.push(m));
    expect(received).toEqual([hello("early")]);
  });

  it("stops delivering to an unsubscribed handler", async () => {
    const { host, guest } = await connectedPair();
    const received: CoopMessage[] = [];
    const unsubscribe = guest.onMessage(m => received.push(m));
    unsubscribe();
    host.send({ t: "bye" });
    await flush();
    expect(received).toEqual([]);
  });

  it("notifies the peer on close", async () => {
    const { host, guest } = await connectedPair();
    const guestStatuses: CoopConnectionStatus[] = [];
    guest.onStatusChange(s => guestStatuses.push(s));

    host.close();
    expect(guestStatuses).toEqual(["closed"]);
    expect(() => host.send({ t: "bye" })).not.toThrow();
  });

  it("join rejects an unknown code", async () => {
    const { host, guest } = createLoopbackPair();
    await host.host();
    await expect(guest.join("ZZZZZZ")).rejects.toThrow("unknown join code");
  });
});
