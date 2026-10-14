/**
 * Which player owns each party pokemon in a co-op run.
 * @module
 */

import type { CoopRole } from "#coop/coop-protocol";

/** Each player may own at most this many pokemon. */
export const COOP_MAX_OWNED = 3;

/** Maps `PlayerPokemon.id` to its owner. Saved with the session. */
export class CoopOwnership {
  private readonly owners = new Map<number, CoopRole>();

  set(pokemonId: number, owner: CoopRole): void {
    this.owners.set(pokemonId, owner);
  }

  get(pokemonId: number): CoopRole | undefined {
    return this.owners.get(pokemonId);
  }

  remove(pokemonId: number): void {
    this.owners.delete(pokemonId);
  }

  /**
   * Count the pokemon `owner` has in the party.
   * @param partyIds - IDs of the pokemon currently in the party; owned pokemon that left it are not counted
   */
  countOwnedBy(owner: CoopRole, partyIds: readonly number[]): number {
    return partyIds.filter(id => this.owners.get(id) === owner).length;
  }

  toJSON(): Record<number, CoopRole> {
    return Object.fromEntries(this.owners);
  }

  static fromJSON(data: Record<number, CoopRole>): CoopOwnership {
    const ownership = new CoopOwnership();
    for (const [id, owner] of Object.entries(data)) {
      ownership.set(Number(id), owner);
    }
    return ownership;
  }
}
