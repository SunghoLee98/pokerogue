import { CoopHandshakeError, CoopVersionMismatchError, performHandshake } from "#coop/coop-handshake";
import type { CoopMessage } from "#coop/coop-protocol";
import { createLoopbackPair } from "#coop/loopback-transport";
import { afterEach, describe, expect, it, vi } from "vitest";

async function connectedPair() {
  const pair = createLoopbackPair();
  const { joinCode } = await pair.host.host();
  await pair.guest.join(joinCode);
  return pair;
}

describe("performHandshake", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("exchanges account names", async () => {
    const { host, guest } = await connectedPair();
    const [hostResult, guestResult] = await Promise.all([
      performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" }),
      performHandshake(guest, { gameVersion: "1.12.1.0", accountName: "bob" }),
    ]);
    expect(hostResult).toMatchObject({ peerAccountName: "bob" });
    expect(guestResult).toMatchObject({ peerAccountName: "alice" });
  });

  it("shares trainer ids and whether the host resumes a saved run", async () => {
    const { host, guest } = await connectedPair();
    const [hostResult, guestResult] = await Promise.all([
      performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice", trainerId: 11, resume: true }),
      performHandshake(guest, { gameVersion: "1.12.1.0", accountName: "bob", trainerId: 22 }),
    ]);
    expect(hostResult).toEqual({ peerAccountName: "bob", peerTrainerId: 22, peerResume: false });
    expect(guestResult).toEqual({ peerAccountName: "alice", peerTrainerId: 11, peerResume: true });
  });

  it("works when one side starts later", async () => {
    const { host, guest } = await connectedPair();
    const hostHandshake = performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" });
    await new Promise(resolve => setTimeout(resolve, 0));
    const guestResult = await performHandshake(guest, { gameVersion: "1.12.1.0", accountName: "bob" });
    expect(guestResult).toMatchObject({ peerAccountName: "alice" });
    await expect(hostHandshake).resolves.toMatchObject({ peerAccountName: "bob" });
  });

  it("releases its subscriptions when done", async () => {
    const { host, guest } = await connectedPair();
    await Promise.all([
      performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" }),
      performHandshake(guest, { gameVersion: "1.12.1.0", accountName: "bob" }),
    ]);
    const received: CoopMessage[] = [];
    guest.onMessage(m => received.push(m));
    host.send({ t: "bye" });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(received).toEqual([{ t: "bye" }]);
  });

  it("rejects mismatched game versions on both sides", async () => {
    const { host, guest } = await connectedPair();
    const results = await Promise.allSettled([
      performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" }),
      performHandshake(guest, { gameVersion: "1.12.2.0", accountName: "bob" }),
    ]);
    const [hostError, guestError] = results.map(r => (r.status === "rejected" ? r.reason : null));

    expect(hostError).toBeInstanceOf(CoopVersionMismatchError);
    expect(hostError).toMatchObject({ localVersion: "1.12.1.0", peerVersion: "1.12.2.0" });
    expect(guestError).toBeInstanceOf(CoopVersionMismatchError);
    expect(guestError).toMatchObject({ localVersion: "1.12.2.0", peerVersion: "1.12.1.0" });
  });

  it("rejects mismatched protocol versions", async () => {
    const { host, guest } = await connectedPair();
    const handshake = performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" });
    guest.send({ t: "hello", gameVersion: "1.12.1.0", protocol: 999, accountName: "bob", trainerId: 0 });
    await expect(handshake).rejects.toBeInstanceOf(CoopVersionMismatchError);
  });

  it("rejects when the peer closes before hello", async () => {
    const { host, guest } = await connectedPair();
    const handshake = performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" });
    guest.close();
    await expect(handshake).rejects.toBeInstanceOf(CoopHandshakeError);
  });

  it("rejects when the peer says bye before hello", async () => {
    const { host, guest } = await connectedPair();
    const handshake = performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" });
    guest.send({ t: "bye" });
    await expect(handshake).rejects.toBeInstanceOf(CoopHandshakeError);
  });

  it("times out", async () => {
    vi.useFakeTimers();
    const { host } = await connectedPair();
    const handshake = performHandshake(host, { gameVersion: "1.12.1.0", accountName: "alice" });
    const assertion = expect(handshake).rejects.toBeInstanceOf(CoopHandshakeError);
    await vi.advanceTimersByTimeAsync(14_999);
    let settled = false;
    handshake.catch(() => {}).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});
