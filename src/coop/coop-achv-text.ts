/**
 * Names for co-op achievements. The achievement texts live in the separate locales repository, which co-op does not
 * modify, so co-op achievements use the built-in co-op texts instead.
 * @module
 */

import { type CoopTextKey, coopText } from "#coop/coop-text";
import type { Achv } from "#system/achv";

/** Give an achievement co-op texts for its name and description. */
export function withCoopAchvText<T extends Achv>(achv: T, name: CoopTextKey, description: CoopTextKey): T {
  Object.defineProperties(achv, {
    name: { get: () => coopText(name) },
    description: { get: () => coopText(description) },
  });
  return achv;
}
