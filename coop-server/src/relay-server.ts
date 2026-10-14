// SPDX-FileCopyrightText: 2026 SunghoLee98
// SPDX-License-Identifier: AGPL-3.0-only

import type { IncomingMessage } from "node:http";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { RELAY_PREFIX, type RelayControlMessage, type RelaySlot } from "./relay-protocol.ts";
import { RoomRegistry } from "./room-registry.ts";

const SWEEP_INTERVAL_MS = 10_000;

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
  const wss = new WebSocketServer({ port: options.port, host: options.host });

  const attach = (socket: WebSocket, code: string, slot: RelaySlot): void => {
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

    socket.on("close", () => {
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
      sendControl(peer, { t: "relay:paired" });
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
    const slot: RelaySlot = rejoin ?? "guest";
    const result = registry.join(code, slot);
    if (result !== "ok") {
      reject(socket, result, code);
      return;
    }
    attach(socket, code, slot);
  });

  const sweepTimer = setInterval(() => {
    for (const code of registry.sweep()) {
      const room = sockets.get(code);
      sockets.delete(code);
      room?.host?.close();
      room?.guest?.close();
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const close = (): Promise<void> => {
    clearInterval(sweepTimer);
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
