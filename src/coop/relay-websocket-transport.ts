// Relay control messages below are duplicated from coop-server/src/relay-protocol.ts. Keep them in sync.

/**
 * Transport that talks to the co-op relay server over WebSocket.
 * Also used for local play, where the relay runs on the host's machine.
 * @module
 */

import {
  type CoopMessage,
  type CoopRole,
  decodeCoopMessage,
  encodeCoopMessage,
  normalizeJoinCode,
} from "#coop/coop-protocol";
import {
  type CoopConnectionStatus,
  type CoopTransport,
  CoopTransportListeners,
  type Unsubscribe,
} from "#coop/coop-transport";

const RELAY_PREFIX = "relay:";

export type RelayErrorReason = "notFound" | "full" | "badRequest";

type RelayControlMessage =
  | { t: "relay:code"; code: string }
  | { t: "relay:slot"; slot: CoopRole }
  | { t: "relay:paired"; fresh?: true }
  | { t: "relay:peerLeft" }
  | { t: "relay:waiting" }
  | { t: "relay:error"; reason: RelayErrorReason };

const RECONNECT_INTERVAL_MS = 2_000;
/** Matches how long the relay keeps a vacated slot. */
const RECONNECT_GIVE_UP_MS = 60_000;
const SOCKET_OPEN = 1;

export class CoopRelayError extends Error {
  readonly reason: RelayErrorReason;

  constructor(reason: RelayErrorReason) {
    super(`coop relay error: ${reason}`);
    this.name = "CoopRelayError";
    this.reason = reason;
  }
}

interface PendingConnect {
  resolve: () => void;
  reject: (error: Error) => void;
}

export class RelayWebSocketTransport implements CoopTransport {
  private readonly listeners = new CoopTransportListeners();
  private readonly relayUrl: string;
  private readonly createSocket: (url: string) => WebSocket;
  private socket: WebSocket | null = null;
  private role: CoopRole | null = null;
  /** The relay slot to take back after a dropped connection, when it is not the role (a returning host joins). */
  private slot: CoopRole | null = null;
  private code: string | null = null;
  private everPaired = false;
  /** The `host()` or `join()` call waiting for the relay to answer. */
  private pending: PendingConnect | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private giveUpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(relayUrl: string, createSocket: (url: string) => WebSocket = url => new WebSocket(url)) {
    this.relayUrl = relayUrl;
    this.createSocket = createSocket;
  }

  host(): Promise<{ joinCode: string }> {
    this.role = "host";
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.open({ role: "host" });
    }).then(() => ({ joinCode: this.code! }));
  }

  join(joinCode: string): Promise<void> {
    this.role = "guest";
    this.code = joinCode;
    return new Promise<void>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.open({ code: joinCode });
    });
  }

  get status(): CoopConnectionStatus {
    return this.listeners.status;
  }

  get joinCode(): string | null {
    return this.code;
  }

  send(message: CoopMessage): void {
    // Messages sent while the connection is down are dropped; the relay would drop them anyway with no peer.
    if (this.socket?.readyState === SOCKET_OPEN) {
      this.socket.send(encodeCoopMessage(message));
    }
  }

  onMessage(handler: (message: CoopMessage) => void): Unsubscribe {
    return this.listeners.onMessage(handler);
  }

  onStatusChange(handler: (status: CoopConnectionStatus) => void): Unsubscribe {
    return this.listeners.onStatusChange(handler);
  }

  close(): void {
    this.shutDown(new Error("transport closed"));
  }

  private open(query: Record<string, string>): void {
    const separator = this.relayUrl.includes("?") ? "&" : "?";
    const socket = this.createSocket(`${this.relayUrl}${separator}${new URLSearchParams(query)}`);
    this.socket = socket;
    socket.onmessage = event => {
      if (socket === this.socket && typeof event.data === "string") {
        this.handleFrame(event.data);
      }
    };
    socket.onclose = () => {
      if (socket === this.socket) {
        this.socket = null;
        this.handleSocketClosed();
      }
    };
  }

  private handleFrame(text: string): void {
    const control = parseControlMessage(text);
    if (control) {
      this.handleControl(control);
      return;
    }
    const message = decodeCoopMessage(text);
    if (message) {
      this.listeners.emitMessage(message);
    } else {
      console.warn("coop: dropping undecodable frame", text);
    }
  }

  private handleControl(control: RelayControlMessage): void {
    switch (control.t) {
      case "relay:code":
        this.code = control.code;
        this.listeners.setStatus("waitingForPeer");
        this.settlePending();
        break;
      case "relay:slot":
        this.slot = control.slot;
        break;
      case "relay:paired":
        this.clearReconnectTimers();
        this.listeners.setStatus(control.fresh && this.everPaired ? "newPeer" : "connected");
        this.everPaired = true;
        this.settlePending();
        break;
      case "relay:peerLeft":
        this.listeners.setStatus("reconnecting");
        break;
      case "relay:waiting":
        // Back in the room, but the partner is away: stop retrying and keep waiting for them.
        this.clearReconnectTimers();
        this.listeners.setStatus(this.everPaired ? "reconnecting" : "waitingForPeer");
        break;
      case "relay:error":
        // While rejoining, "full" means the relay has not noticed our old socket dropping yet: keep retrying.
        if (this.giveUpTimer !== null && control.reason === "full") {
          break;
        }
        this.shutDown(new CoopRelayError(control.reason));
        break;
    }
  }

  private handleSocketClosed(): void {
    if (this.listeners.status === "closed") {
      return;
    }
    if (this.pending || this.code === null || this.role === null) {
      this.shutDown(new Error("connection to the coop relay closed"));
      return;
    }
    this.listeners.setStatus("reconnecting");
    this.giveUpTimer ??= setTimeout(() => this.shutDown(new Error("coop reconnect timed out")), RECONNECT_GIVE_UP_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open({ code: this.code!, rejoin: this.slot ?? this.role! });
    }, RECONNECT_INTERVAL_MS);
  }

  private settlePending(): void {
    this.pending?.resolve();
    this.pending = null;
  }

  private clearReconnectTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.giveUpTimer !== null) {
      clearTimeout(this.giveUpTimer);
      this.giveUpTimer = null;
    }
  }

  /** Stop for good: reject any waiting connect call, close the socket and report `"closed"`. */
  private shutDown(reason: Error): void {
    this.clearReconnectTimers();
    this.pending?.reject(reason);
    this.pending = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
    this.listeners.setStatus("closed");
  }
}

function parseControlMessage(text: string): RelayControlMessage | null {
  if (!text.includes(RELAY_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.t === "string" && parsed.t.startsWith(RELAY_PREFIX) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Parse what a guest typed into the join box.
 * Accepts a bare code (`abc123`) for the default relay, or `address/code` (`192.168.0.10:8787/ABC123`) for local play.
 * @returns The relay to connect to and the normalized code, or `null` if the input is invalid
 */
export function parseJoinInput(input: string, defaultRelayUrl: string): { relayUrl: string; code: string } | null {
  const slash = input.lastIndexOf("/");
  const code = normalizeJoinCode(input.slice(slash + 1));
  if (code === null) {
    return null;
  }
  if (slash === -1) {
    return { relayUrl: defaultRelayUrl, code };
  }
  const address = input.slice(0, slash).trim();
  if (address === "") {
    return null;
  }
  const relayUrl = /^wss?:\/\//.test(address) ? address : `ws://${address}`;
  return { relayUrl, code };
}

export function getDefaultRelayUrl(): string | undefined {
  return import.meta.env.VITE_COOP_RELAY_URL;
}
