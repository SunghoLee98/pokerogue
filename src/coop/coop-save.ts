/**
 * Co-op session saves (spec 3.8, 4.6): the `coop` block saved with the session, and who saves.
 * @module
 */

import { pokerogueApi } from "#api/api";
import { clientSessionId } from "#app/account";
import { bypassLogin } from "#constants/app-constants";
import { COOP_PROTOCOL_VERSION, type CoopAccountSnapshot, type CoopRole } from "#coop/coop-protocol";
import { getCoopRewardCounters } from "#coop/coop-reward";
import { COOP_SESSION_SLOT, type CoopSession, coopSession } from "#coop/coop-session";
import type { GameData } from "#system/game-data";

/** What a co-op run saves besides the solo session fields. Only the host's account keeps the save. */
export interface CoopSessionSaveData {
  /** The protocol version of the client that saved */
  protocol: number;
  /** Account names */
  participants: Record<CoopRole, string>;
  /** Party pokemon id → owner */
  ownership: Record<number, CoopRole>;
  /** The account data each player's simulation used */
  accounts: Record<CoopRole, CoopAccountSnapshot>;
  timedEvent: string | null;
  /** The session's next decision number */
  decisionSeq: number;
  /** The newest reward screen's number */
  rewardGen: number;
  /** The number of reward screen events applied */
  rewardSeq: number;
}

/**
 * Read a `coop` block as the save server returns it.
 * The server stores saves with Go's gob, which drops empty values: empty lists and maps come back as `null`.
 */
export function normalizeCoopSaveData(raw: unknown): CoopSessionSaveData {
  const data = raw as Partial<CoopSessionSaveData>;
  const account = (snapshot: Partial<CoopAccountSnapshot> | undefined): CoopAccountSnapshot => ({
    trainerId: snapshot?.trainerId ?? 0,
    secretId: snapshot?.secretId ?? 0,
    caughtSpecies: snapshot?.caughtSpecies ?? [],
    eggMoves: snapshot?.eggMoves ?? {},
    unlocks: snapshot?.unlocks ?? [],
  });
  return {
    protocol: data.protocol ?? 0,
    participants: { host: data.participants?.host ?? "", guest: data.participants?.guest ?? "" },
    ownership: data.ownership ?? {},
    accounts: { host: account(data.accounts?.host), guest: account(data.accounts?.guest) },
    timedEvent: data.timedEvent ?? null,
    decisionSeq: data.decisionSeq ?? 0,
    rewardGen: data.rewardGen ?? 0,
    rewardSeq: data.rewardSeq ?? 0,
  };
}

/** The `coop` block for a session's current state. */
export function createCoopSaveData(session: CoopSession): CoopSessionSaveData {
  const rewards = getCoopRewardCounters(session);
  return {
    protocol: COOP_PROTOCOL_VERSION,
    participants: { ...session.participants },
    ownership: session.ownership.toJSON(),
    accounts: { host: session.getAccountSnapshot("host"), guest: session.getAccountSnapshot("guest") },
    timedEvent: session.timedEvent,
    decisionSeq: session.decisionCount,
    rewardGen: rewards.gen,
    rewardSeq: rewards.seq,
  };
}

/**
 * The co-op fields of the session save (`GameData.getSessionSaveData`).
 * @returns `{ coop }` in co-op; nothing outside it, so solo saves have no `coop` key at all
 */
export function getCoopSaveFields(): { coop?: CoopSessionSaveData } {
  return coopSession ? { coop: createCoopSaveData(coopSession) } : {};
}

/**
 * The save a co-op guest makes in place of `GameData.saveAll` (spec 3.8: only the host keeps the session).
 * The guest's account data (dex, candies, eggs...) is still saved, the same way and as often as in solo.
 * @returns `null` outside the guest's client, where `saveAll` saves as usual
 */
export function saveCoopGuestData(gameData: GameData, sync: boolean): Promise<boolean> | null {
  if (coopSession?.localRole !== "guest") {
    return null;
  }
  // `saveSystem` stores locally and, online, on the server; without `sync` solo only stores locally.
  return sync || bypassLogin ? gameData.saveSystem() : Promise.resolve(true);
}

/** Whether a save server answer to reading the co-op slot is the range error of a server without that slot. */
export function isCoopSlotRangeError(response: string | null): boolean {
  return response?.includes(`slot id ${COOP_SESSION_SLOT} out of range`) ?? false;
}

let saveServerAnswer: boolean | null = null;

/**
 * Whether the save server can store co-op runs (spec 4.6 compatibility).
 * A modified frontend on an unmodified server hides co-op: such a server answers reading the co-op slot with a range
 * error. Offline, saves stay in the browser and any slot works. Replaced in tests.
 */
export const coopSaveServer = {
  async supportsCoop(): Promise<boolean> {
    if (bypassLogin) {
      return true;
    }
    if (saveServerAnswer !== null) {
      return saveServerAnswer;
    }
    const response = await pokerogueApi.savedata.session.get({ slot: COOP_SESSION_SLOT, clientSessionId });
    if (response === null) {
      // No answer at all: ask again next time.
      return false;
    }
    saveServerAnswer = !isCoopSlotRangeError(response);
    return saveServerAnswer;
  },
  /** Forget the answer, to ask again. */
  reset(): void {
    saveServerAnswer = null;
  },
};

/** Whether a session slot is the co-op one (spec 4.6). */
export function isCoopSessionSlot(slotId: number): boolean {
  return slotId === COOP_SESSION_SLOT;
}
