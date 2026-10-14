/**
 * Catching in co-op (spec 3.3): the caught pokemon belongs to the thrower, each player may own at most three, and the
 * thrower's account decides the critical capture chance.
 * @module
 */

import { PLAYER_PARTY_MAX_SIZE } from "#app/constants";
import { globalScene } from "#app/global-scene";
import { COOP_MAX_OWNED } from "#coop/coop-ownership";
import type { CoopDecision, CoopRole } from "#coop/coop-protocol";
import { type CoopSession, coopSession } from "#coop/coop-session";
import { getPokemonSimData, getWorldSimData, type SimAccountData } from "#coop/coop-sim-data";
import { coopText } from "#coop/coop-text";
import type { Pokemon } from "#field/pokemon";

/**
 * Account data for the critical capture chance: the thrower's account (spec 3.3, 4.1).
 * In solo, and when the thrower is unknown, the same world data as before.
 * @param throwerId - The `id` of the player pokemon that threw the ball
 */
export function getCaptureSimData(throwerId?: number): SimAccountData {
  return coopSession && throwerId !== undefined ? getPokemonSimData(throwerId) : getWorldSimData();
}

function getThrowerRole(session: CoopSession, throwerId: number): CoopRole {
  return session.ownership.get(throwerId) ?? "host";
}

/**
 * Whether catching would take the thrower over their limit, so they must release a pokemon or let the catch go.
 * Solo: the party is full. Co-op: the thrower's owner already has {@linkcode COOP_MAX_OWNED} pokemon (spec 4.4).
 * @param throwerId - The `id` of the player pokemon that threw the ball
 */
export function isCaptureRosterFull(throwerId?: number): boolean {
  const party = globalScene.getPlayerParty();
  if (!coopSession || throwerId === undefined) {
    return party.length === PLAYER_PARTY_MAX_SIZE;
  }
  const owner = getThrowerRole(coopSession, throwerId);
  return (
    coopSession.ownership.countOwnedBy(
      owner,
      party.map(p => p.id),
    ) >= COOP_MAX_OWNED
  );
}

/**
 * Record that a caught pokemon belongs to whoever threw the ball.
 * Called as the catch succeeds, with the enemy: the party pokemon made from it keeps its `id`, so the catch's account
 * records (spec 3.7) already go to the thrower's account.
 */
export function registerCoopCapture(caught: Pokemon | null, throwerId?: number): void {
  if (coopSession && caught && throwerId !== undefined) {
    coopSession.ownership.set(caught.id, getThrowerRole(coopSession, throwerId));
  }
}

/** What the capture does with the thrower's choice. */
export interface CoopCaptureHandlers {
  /** Add the catch at this party index (after the released pokemon is gone) */
  replace(insertIndex: number): void;
  /** Let the catch go */
  keepOut(): void;
}

/**
 * The thrower's choice after a catch with a full roster: release one of their pokemon, or let the catch go.
 * The thrower's client asks the usual questions and reports the outcome; the partner's client waits for it and
 * applies the same outcome.
 */
export class CoopCaptureDecision {
  private readonly session: CoopSession;
  private readonly seq: number;
  /** Party ids when the choice began, to tell which pokemon the release took */
  private readonly partyIds: number[];
  readonly isLocal: boolean;

  /** @param owner - The player who caught the pokemon and chooses */
  constructor(session: CoopSession, owner: CoopRole) {
    this.session = session;
    this.seq = session.nextDecisionSeq();
    this.partyIds = globalScene.getPlayerParty().map(p => p.id);
    this.isLocal = owner === session.localRole;
  }

  /** The local thrower released a pokemon in the party screen and adds the catch at `insertIndex`. */
  replaced(insertIndex: number): void {
    const remaining = new Set(globalScene.getPlayerParty().map(p => p.id));
    const releasedId = this.partyIds.find(id => !remaining.has(id));
    if (releasedId === undefined) {
      throw new Error("no pokemon was released to make room for the catch");
    }
    this.send({ kind: "capture", seq: this.seq, action: "replace", releasedId, insertIndex });
  }

  /** The local thrower let the catch go. */
  keptOut(): void {
    this.send({ kind: "capture", seq: this.seq, action: "keepOut" });
  }

  /**
   * On the partner's client, wait for the thrower's choice and apply it.
   * @returns `false` on the thrower's client, which asks the player instead
   */
  awaitThrower(handlers: CoopCaptureHandlers): boolean {
    if (this.isLocal) {
      return false;
    }
    const session = this.session;
    globalScene.ui.showText(coopText("waitingForPartnerChoice"));
    session.inputs.waitDecision(this.seq).then(decision => {
      if (coopSession !== session) {
        return;
      }
      if (decision.kind !== "capture") {
        throw new Error(`expected the partner's capture choice ${this.seq}, got ${decision.kind}`);
      }
      // `clearText` would be refilled by the text still being typed.
      globalScene.ui.showText("", 0);
      if (decision.action === "replace") {
        releasePartyMember(decision.releasedId);
        handlers.replace(decision.insertIndex);
      } else {
        handlers.keepOut();
      }
    });
    return true;
  }

  private send(decision: CoopDecision): void {
    this.session.inputs.send({
      t: "choice",
      kind: decision.kind,
      wave: globalScene.currentBattle.waveIndex,
      payload: decision,
    });
  }
}

/** Release a party member the way the party screen does. */
function releasePartyMember(pokemonId: number): void {
  const party = globalScene.getPlayerParty();
  const index = party.findIndex(p => p.id === pokemonId);
  if (index === -1) {
    throw new Error(`the released pokemon ${pokemonId} is not in the party`);
  }
  globalScene.removePartyMemberModifiers(index);
  party.splice(index, 1)[0].destroy();
}

/**
 * Begin the thrower's choice after a catch with a full roster.
 * @returns `null` outside co-op or when the thrower is unknown
 */
export function beginCoopCaptureDecision(throwerId?: number): CoopCaptureDecision | null {
  return coopSession && throwerId !== undefined
    ? new CoopCaptureDecision(coopSession, getThrowerRole(coopSession, throwerId))
    : null;
}

/**
 * Who gets a pokemon a mystery encounter gives (spec 3.10): the player who chose the encounter's option, that is the
 * wave's picker.
 */
function getEncounterChooser(session: CoopSession): CoopRole {
  return session.pickerForWave(globalScene.currentBattle.waveIndex);
}

/**
 * Record that a pokemon a mystery encounter gives (`catchPokemon`) belongs to the player who chose the option.
 * Called before the catch's account records, which then go to that player's account.
 */
export function registerCoopEncounterCatch(pokemon: Pokemon): void {
  if (coopSession) {
    coopSession.ownership.set(pokemon.id, getEncounterChooser(coopSession));
  }
}

/**
 * Whether a pokemon a mystery encounter gives needs room first.
 * Solo: the party is full. Co-op: the chooser already owns {@linkcode COOP_MAX_OWNED} pokemon.
 */
export function isEncounterCatchRosterFull(): boolean {
  const party = globalScene.getPlayerParty();
  if (!coopSession) {
    return party.length === PLAYER_PARTY_MAX_SIZE;
  }
  return (
    coopSession.ownership.countOwnedBy(
      getEncounterChooser(coopSession),
      party.map(p => p.id),
    ) >= COOP_MAX_OWNED
  );
}

/**
 * Begin the chooser's choice when an encounter gives a pokemon to a full roster, as for a catch.
 * @returns `null` outside co-op
 */
export function beginCoopEncounterCatchDecision(): CoopCaptureDecision | null {
  return coopSession ? new CoopCaptureDecision(coopSession, getEncounterChooser(coopSession)) : null;
}
