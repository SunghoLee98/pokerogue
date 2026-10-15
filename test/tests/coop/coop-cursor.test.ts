import { CoopCursorSender, CoopStarterCursorShare } from "#coop/coop-cursor";
import { CoopInputBroker } from "#coop/coop-input-broker";
import type { CoopCursorAt, CoopMessage } from "#coop/coop-protocol";
import { createLoopbackPair } from "#coop/loopback-transport";
import { describe, expect, it } from "vitest";

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

async function connectedPair() {
  const pair = createLoopbackPair();
  await pair.host.host();
  await pair.guest.join("LOOP00");
  return pair;
}

describe("co-op cursor sharing", () => {
  it("sends the cursor only when it moved", () => {
    const sent: CoopMessage[] = [];
    const sender = new CoopCursorSender(message => sent.push(message));

    sender.report({ screen: "starter", speciesId: 1 });
    sender.report({ screen: "starter", speciesId: 1 });
    sender.report({ screen: "starter", speciesId: 4 });
    sender.report(null);
    sender.report(null);

    expect(sent).toEqual([
      { t: "cursor", at: { screen: "starter", speciesId: 1 } },
      { t: "cursor", at: { screen: "starter", speciesId: 4 } },
      { t: "cursor", at: null },
    ]);
  });

  it("shows the partner's starter cursor by species and hides it when they leave the grid", async () => {
    const { host, guest } = await connectedPair();
    const shown: (number | null)[] = [];
    const share = new CoopStarterCursorShare(
      message => guest.send(message),
      handler => guest.onMessage(handler),
      { showPartnerCursor: speciesId => shown.push(speciesId) },
    );

    host.send({ t: "cursor", at: { screen: "starter", speciesId: 7 } });
    await flush();
    expect(share.partnerSpecies).toBe(7);
    // A reward screen cursor is not shown on the starter grid
    host.send({ t: "cursor", at: { screen: "reward", gen: 0, row: 1, cursor: 0 } });
    await flush();
    expect(shown).toEqual([7, null]);

    share.refresh();
    expect(shown.at(-1)).toBeNull();
  });

  it("tells the partner the local starter cursor, and that it left when the screen closes", async () => {
    const { host, guest } = await connectedPair();
    const received: CoopMessage[] = [];
    host.onMessage(message => received.push(message));
    const share = new CoopStarterCursorShare(
      message => guest.send(message),
      handler => guest.onMessage(handler),
      { showPartnerCursor: () => {} },
    );

    share.report(25);
    share.report(25);
    share.dispose();
    await flush();

    expect(received).toEqual([
      { t: "cursor", at: { screen: "starter", speciesId: 25 } },
      { t: "cursor", at: null },
    ]);
  });

  it("keeps where the partner's cursor is now in the input broker", async () => {
    const { host, guest } = await connectedPair();
    const broker = new CoopInputBroker(host);
    const heard: (CoopCursorAt | null)[] = [];
    broker.onCursor(at => heard.push(at));

    guest.send({ t: "cursor", at: { screen: "reward", gen: 2, row: 1, cursor: 1 } });
    guest.send({ t: "cursor", at: { screen: "reward", gen: 2, row: 2, cursor: 0 } });
    await flush();

    expect(broker.partnerCursor).toEqual({ screen: "reward", gen: 2, row: 2, cursor: 0 });
    expect(heard).toHaveLength(2);
    broker.dispose();
  });
});
