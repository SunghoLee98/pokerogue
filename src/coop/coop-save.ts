/**
 * Co-op session saves (spec 3.8, 4.6): the `coop` block saved with the session, and who saves.
 * @module
 */

import { COOP_PROTOCOL_VERSION, type CoopAccountSnapshot, type CoopRole } from "#coop/coop-protocol";
import { getCoopRewardCounters } from "#coop/coop-reward";
import { type CoopSession, coopSession } from "#coop/coop-session";

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
