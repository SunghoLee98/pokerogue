// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage } from "node:http";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { RELAY_PREFIX, type RelayControlMessage, type RelaySlot } from "./relay-protocol.ts";
import { RoomRegistry } from "./room-registry.ts";

const SWEEP_INTERVAL_MS = 10_000;
/** Ping every socket this often; one that has not answered the previous ping is dropped. */
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface RelayServer {
  port: number;
  close(): Promise<void>;
}

type RoomSockets = Partial<Record<RelaySlot, WebSocket>>;

function sendControl(socket: WebSocket, message: RelayControlMessage): void {
  socket.send(JSON.stringify(message));
}

function otherSlot(slot: RelaySlot): RelaySlot {
  return slot === "host" ? "guest" : "host";
}

/** Whether a client frame pretends to be a relay control message. Such frames are never forwarded. */
function isControlFrame(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.t === "string" && parsed.t.startsWith(RELAY_PREFIX);
  } catch {
    return false;
  }
}

/**
 * Start a relay that pairs two sockets by join code and forwards text frames between them.
 * It never interprets game messages.
 */
export function startRelayServer(options: { port: number; host?: string }): Promise<RelayServer> {
  const registry = new RoomRegistry();
  const sockets = new Map<string, RoomSockets>();
  /** Rooms where both players have been in at some point. */
  const pairedRooms = new Set<string>();
  /** Sockets that answered the last heartbeat ping. */
  const alive = new WeakSet<WebSocket>();
  const wss = new WebSocketServer({ port: options.port, host: options.host });

  /**
   * @param fresh - The client joined with the code alone, not to take back its slot after a dropped connection
   */
  const attach = (socket: WebSocket, code: string, slot: RelaySlot, fresh = false): void => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    const room = sockets.get(code) ?? {};
    sockets.set(code, room);
    room[slot] = socket;

    socket.on("message", (data: RawData, isBinary: boolean) => {
      const peer = sockets.get(code)?.[otherSlot(slot)];
      if (isBinary || !peer) {
        return;
      }
      const text = data.toString();
      if (!isControlFrame(text)) {
        peer.send(text);
      }
    });

    socket.on("close", (closeCode: number) => {
      console.log(`coop relay: ${slot} left ${code} (close ${closeCode})`);
      const current = sockets.get(code);
      if (current?.[slot] !== socket) {
        return;
      }
      delete current[slot];
      registry.leave(code, slot);
      const peer = current[otherSlot(slot)];
      if (peer) {
        sendControl(peer, { t: "relay:peerLeft" });
      }
    });

    const peer = room[otherSlot(slot)];
    if (peer) {
      sendControl(socket, { t: "relay:paired" });
      sendControl(peer, fresh && pairedRooms.has(code) ? { t: "relay:paired", fresh: true } : { t: "relay:paired" });
      pairedRooms.add(code);
    }
  };

  const reject = (socket: WebSocket, reason: "notFound" | "full" | "badRequest", code?: string | null): void => {
    console.log(`coop relay: rejected ${code ?? "(no code)"}: ${reason} (${sockets.size} rooms open)`);
    sendControl(socket, { t: "relay:error", reason });
    socket.close();
  };

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const params = new URL(request.url ?? "/", "ws://relay").searchParams;
    const code = params.get("code");
    const rejoin = params.get("rejoin");

    if (params.get("role") === "host" && code === null) {
      const newCode = registry.createRoom();
      attach(socket, newCode, "host");
      sendControl(socket, { t: "relay:code", code: newCode });
      console.log(`coop relay: room ${newCode} created`);
      return;
    }
    if (code === null || (rejoin !== null && rejoin !== "host" && rejoin !== "guest")) {
      reject(socket, "badRequest", code);
      return;
    }
    const result = registry.join(code, rejoin ?? undefined);
    if (result === "notFound" || result === "full") {
      reject(socket, result, code);
      return;
    }
    console.log(`coop relay: ${result} ${rejoin ? "rejoined" : "joined"} ${code}`);
    if (!rejoin && result === "host") {
      sendControl(socket, { t: "relay:slot", slot: result });
    }
    attach(socket, code, result, rejoin === null);
    if (rejoin && !sockets.get(code)?.[otherSlot(result)]) {
      sendControl(socket, { t: "relay:waiting" });
    }
  });

  const sweepTimer = setInterval(() => {
    for (const code of registry.sweep()) {
      console.log(`coop relay: room ${code} closed`);
      const room = sockets.get(code);
      sockets.delete(code);
      pairedRooms.delete(code);
      room?.host?.close();
      room?.guest?.close();
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // Without traffic, a connection that died on the way (a phone losing signal) never closes on its own,
  // and the room would keep that player's slot taken.
  const heartbeatTimer = setInterval(() => {
    for (const client of wss.clients) {
      if (!alive.has(client)) {
        client.terminate();
        continue;
      }
      alive.delete(client);
      client.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const close = (): Promise<void> => {
    clearInterval(sweepTimer);
    clearInterval(heartbeatTimer);
    for (const client of wss.clients) {
      client.terminate();
    }
    return new Promise((resolve, rejectClose) => wss.close(error => (error ? rejectClose(error) : resolve())));
  };

  return new Promise((resolve, rejectStart) => {
    wss.once("error", rejectStart);
    wss.once("listening", () => {
      wss.off("error", rejectStart);
      const address = wss.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({ port, close });
    });
  });
}
