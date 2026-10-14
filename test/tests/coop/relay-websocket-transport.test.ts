import { COOP_PROTOCOL_VERSION, type CoopMessage } from "#coop/coop-protocol";
import type { CoopConnectionStatus } from "#coop/coop-transport";
import { CoopRelayError, parseJoinInput, RelayWebSocketTransport } from "#coop/relay-websocket-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Minimal stand-in for a browser `WebSocket`, driven by the test. */
class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emitClose();
  }

  emitOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emitMessage(text: string): void {
    this.onmessage?.({ data: text });
  }

  emitControl(message: Record<string, unknown>): void {
    this.emitMessage(JSON.stringify(message));
  }

  emitClose(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.onclose?.();
  }
}

const hello: CoopMessage = {
  t: "hello",
  gameVersion: "1.0.0",
  protocol: COOP_PROTOCOL_VERSION,
  accountName: "a",
  trainerId: 0,
};

describe("RelayWebSocketTransport", () => {
  let sockets: FakeSocket[];
  let transport: RelayWebSocketTransport;
  let statuses: CoopConnectionStatus[];

  const latest = () => sockets.at(-1)!;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    transport = new RelayWebSocketTransport("wss://relay.test", url => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    });
    statuses = [];
    transport.onStatusChange(s => statuses.push(s));
  });

  afterEach(() => {
    transport.close();
    vi.useRealTimers();
  });

  /** Host a room with code ABC123 and get paired with a guest. */
  async function hostAndPair(): Promise<void> {
    const hosting = transport.host();
    latest().emitOpen();
    latest().emitControl({ t: "relay:code", code: "ABC123" });
    await hosting;
    latest().emitControl({ t: "relay:paired" });
  }

  it("host resolves with the relay code", async () => {
    const hosting = transport.host();
    expect(latest().url).toBe("wss://relay.test?role=host");
    latest().emitOpen();
    latest().emitControl({ t: "relay:code", code: "ABC123" });

    await expect(hosting).resolves.toEqual({ joinCode: "ABC123" });
    expect(statuses.at(-1)).toBe("waitingForPeer");
    latest().emitControl({ t: "relay:paired" });
    expect(statuses.at(-1)).toBe("connected");
  });

  it("join resolves once paired", async () => {
    const joining = transport.join("ABC123");
    expect(latest().url).toBe("wss://relay.test?code=ABC123");
    latest().emitOpen();
    latest().emitControl({ t: "relay:paired" });

    await expect(joining).resolves.toBeUndefined();
    expect(statuses.at(-1)).toBe("connected");
  });

  it("join rejects with the relay error", async () => {
    const joining = transport.join("ZZZZZZ");
    latest().emitOpen();
    latest().emitControl({ t: "relay:error", reason: "notFound" });
    latest().emitClose();

    const error = await joining.catch(e => e);
    expect(error).toBeInstanceOf(CoopRelayError);
    expect(error.reason).toBe("notFound");
    expect(statuses.at(-1)).toBe("closed");
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1); // no reconnect after a rejection
  });

  it("join rejects when the socket closes before pairing", async () => {
    const joining = transport.join("ABC123");
    latest().emitClose();
    await expect(joining).rejects.toThrow();
    expect(statuses.at(-1)).toBe("closed");
  });

  it("sends encoded messages once connected", async () => {
    await hostAndPair();
    transport.send(hello);
    expect(latest().sent).toEqual([JSON.stringify(hello)]);
  });

  it("buffers messages until the first handler subscribes", async () => {
    await hostAndPair();
    latest().emitMessage(JSON.stringify(hello));

    const received: CoopMessage[] = [];
    transport.onMessage(m => received.push(m));
    expect(received).toEqual([hello]);
  });

  it("drops undecodable frames with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await hostAndPair();
    const received: CoopMessage[] = [];
    transport.onMessage(m => received.push(m));
    latest().emitMessage('{"t":"nope"}');

    expect(received).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("reports reconnecting while the peer is away", async () => {
    await hostAndPair();
    latest().emitControl({ t: "relay:peerLeft" });
    expect(statuses.at(-1)).toBe("reconnecting");
    latest().emitControl({ t: "relay:paired" });
    expect(statuses.at(-1)).toBe("connected");
  });

  it("reconnects with rejoin after an unexpected close", async () => {
    await hostAndPair();
    latest().emitClose();
    expect(statuses.at(-1)).toBe("reconnecting");

    vi.advanceTimersByTime(1_999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(latest().url).toBe("wss://relay.test?code=ABC123&rejoin=host");

    latest().emitOpen();
    latest().emitControl({ t: "relay:paired" });
    expect(statuses.at(-1)).toBe("connected");
    vi.advanceTimersByTime(60_000);
    expect(statuses.at(-1)).toBe("connected");
  });

  it("reports a new peer when another client takes the partner's place", async () => {
    await hostAndPair();
    expect(transport.joinCode).toBe("ABC123");
    latest().emitControl({ t: "relay:peerLeft" });
    latest().emitControl({ t: "relay:paired", fresh: true });
    expect(statuses.at(-1)).toBe("newPeer");
    expect(transport.status).toBe("newPeer");
  });

  it("treats the first pairing as connected even when the relay marks it fresh", async () => {
    const hosting = transport.host();
    latest().emitOpen();
    latest().emitControl({ t: "relay:code", code: "ABC123" });
    await hosting;
    latest().emitControl({ t: "relay:paired", fresh: true });
    expect(statuses.at(-1)).toBe("connected");
  });

  it("rejoins the slot the relay gave instead of its role", async () => {
    const joining = transport.join("ABC123");
    latest().emitOpen();
    latest().emitControl({ t: "relay:slot", slot: "host" });
    latest().emitControl({ t: "relay:paired" });
    await joining;

    latest().emitClose();
    vi.advanceTimersByTime(2_000);
    expect(latest().url).toBe("wss://relay.test?code=ABC123&rejoin=host");
  });

  it("stops retrying once back in a room the partner is away from", async () => {
    await hostAndPair();
    latest().emitControl({ t: "relay:peerLeft" });
    latest().emitClose();
    vi.advanceTimersByTime(2_000);
    latest().emitOpen();
    latest().emitControl({ t: "relay:waiting" });

    vi.advanceTimersByTime(120_000);
    expect(statuses.at(-1)).toBe("reconnecting");
    latest().emitControl({ t: "relay:paired", fresh: true });
    expect(statuses.at(-1)).toBe("newPeer");
  });

  it("gives up after sixty seconds", async () => {
    await hostAndPair();
    latest().emitClose();
    for (let elapsed = 0; elapsed < 60_000; elapsed += 2_000) {
      vi.advanceTimersByTime(2_000);
      latest().emitClose();
    }
    expect(statuses.at(-1)).toBe("closed");
    const count = sockets.length;
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(count);
  });

  it("stops reconnecting when the room is gone", async () => {
    await hostAndPair();
    latest().emitClose();
    vi.advanceTimersByTime(2_000);
    latest().emitOpen();
    latest().emitControl({ t: "relay:error", reason: "notFound" });
    latest().emitClose();
    expect(statuses.at(-1)).toBe("closed");
  });

  it("ignores send after close", async () => {
    await hostAndPair();
    const socket = latest();
    transport.close();
    expect(statuses.at(-1)).toBe("closed");
    expect(() => transport.send(hello)).not.toThrow();
    expect(socket.sent).toEqual([]);
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("parseJoinInput", () => {
  it("handles local addresses and messy codes", () => {
    expect(parseJoinInput("192.168.0.10:8787/ ab-c123", "wss://r")).toEqual({
      relayUrl: "ws://192.168.0.10:8787",
      code: "ABC123",
    });
    expect(parseJoinInput("abc123", "wss://r")).toEqual({ relayUrl: "wss://r", code: "ABC123" });
    expect(parseJoinInput("ws://10.0.0.2:8787/abc123", "wss://r")).toEqual({
      relayUrl: "ws://10.0.0.2:8787",
      code: "ABC123",
    });
    expect(parseJoinInput("x/12", "wss://r")).toBeNull();
    expect(parseJoinInput("/abc123", "wss://r")).toBeNull();
  });
});
