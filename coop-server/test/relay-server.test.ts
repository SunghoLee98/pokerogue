// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
// biome-ignore lint/style/noRestrictedImports: the relay server is a separate Node runtime without vitest
import { after, before, describe, it } from "node:test";
import { WebSocket } from "ws";
import { startRelayServer } from "../src/relay-server.ts";

interface TestClient {
  socket: WebSocket;
  /** Resolve with the next text frame, waiting if none is queued. */
  next(): Promise<string>;
  /** Resolve with the next frame parsed as JSON. */
  nextJson(): Promise<Record<string, unknown>>;
  closed: Promise<void>;
}

function connect(url: string): TestClient {
  const socket = new WebSocket(url);
  const queued: string[] = [];
  const waiting: ((text: string) => void)[] = [];
  socket.on("message", data => {
    const text = data.toString();
    const resolve = waiting.shift();
    if (resolve) {
      resolve(text);
    } else {
      queued.push(text);
    }
  });
  const closed = new Promise<void>(resolve => socket.on("close", () => resolve()));
  const next = () => {
    const text = queued.shift();
    return text === undefined ? new Promise<string>(resolve => waiting.push(resolve)) : Promise.resolve(text);
  };
  return { socket, next, nextJson: async () => JSON.parse(await next()), closed };
}

describe("relay server", () => {
  let server: Awaited<ReturnType<typeof startRelayServer>>;
  let baseUrl: string;
  const clients: TestClient[] = [];
  const open = (query: string) => {
    const client = connect(`${baseUrl}/?${query}`);
    clients.push(client);
    return client;
  };

  /** Open a host and a guest and wait until both are paired. */
  async function pair() {
    const host = open("role=host");
    const { code } = (await host.nextJson()) as { code: string };
    const guest = open(`code=${code}`);
    assert.deepEqual(await host.nextJson(), { t: "relay:paired" });
    assert.deepEqual(await guest.nextJson(), { t: "relay:paired" });
    return { host, guest, code };
  }

  before(async () => {
    server = await startRelayServer({ port: 0, host: "127.0.0.1" });
    baseUrl = `ws://127.0.0.1:${server.port}`;
  });

  after(async () => {
    for (const client of clients) {
      client.socket.terminate();
    }
    await server.close();
  });

  it("pairs host and guest and forwards frames verbatim", async () => {
    const host = open("role=host");
    const codeMessage = await host.nextJson();
    assert.equal(codeMessage.t, "relay:code");
    assert.match(codeMessage.code as string, /^[A-Z0-9]{6}$/);

    const guest = open(`code=${codeMessage.code}`);
    assert.deepEqual(await host.nextJson(), { t: "relay:paired" });
    assert.deepEqual(await guest.nextJson(), { t: "relay:paired" });

    host.socket.send('{"t":"hello","x":1}');
    assert.equal(await guest.next(), '{"t":"hello","x":1}');
    guest.socket.send('{"t":"bye"}');
    assert.equal(await host.next(), '{"t":"bye"}');
  });

  it("rejects a third client", async () => {
    const { host, guest, code } = await pair();
    const third = open(`code=${code}`);
    assert.deepEqual(await third.nextJson(), { t: "relay:error", reason: "full" });
    await third.closed;

    host.socket.send('{"t":"bye","n":1}');
    assert.equal(await guest.next(), '{"t":"bye","n":1}');
    guest.socket.send('{"t":"bye","n":2}');
    assert.equal(await host.next(), '{"t":"bye","n":2}');
  });

  it("rejects an unknown code", async () => {
    const client = open("code=ZZZZZZ");
    assert.deepEqual(await client.nextJson(), { t: "relay:error", reason: "notFound" });
    await client.closed;
  });

  it("tells the peer when one side drops and allows rejoin", async () => {
    const { host, guest, code } = await pair();
    guest.socket.close();
    assert.deepEqual(await host.nextJson(), { t: "relay:peerLeft" });

    const rejoined = open(`code=${code}&rejoin=guest`);
    assert.deepEqual(await rejoined.nextJson(), { t: "relay:paired" });
    assert.deepEqual(await host.nextJson(), { t: "relay:paired" });

    host.socket.send('{"t":"bye"}');
    assert.equal(await rejoined.next(), '{"t":"bye"}');
  });

  it("does not forward relay control frames sent by a client", async () => {
    const { host, guest } = await pair();
    host.socket.send('{"t":"relay:peerLeft"}');
    host.socket.send('{"t":"bye"}');
    assert.equal(await guest.next(), '{"t":"bye"}');
  });

  it("rejects a bad request", async () => {
    const client = open("");
    assert.deepEqual(await client.nextJson(), { t: "relay:error", reason: "badRequest" });
    await client.closed;
  });
});
