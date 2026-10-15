/**
 * The animated marker for a co-op ping: a pointing finger drops onto the pinged choice and keeps bobbing over it,
 * while rings ripple out from it, like a map ping. Drawn from plain rectangles (pixel art), so it needs no new assets.
 * @module
 */

import { globalScene } from "#app/global-scene";
import { COOP_PARTNER_CURSOR_TINT } from "#coop/coop-cursor";

/** A hand pointing down, one character per pixel: `#` outline, `.` skin, `c` cuff, space transparent. */
const HAND = [
  "  ######## ",
  "  #cccccc# ",
  "  #......# ",
  " #.......# ",
  " #........#",
  "#.........#",
  "#.#.......#",
  "#.#.....#.#",
  "###..#..#.#",
  "  #..#..## ",
  "  #..###   ",
  "  #..#     ",
  "  #..#     ",
  "  #..#     ",
  "   ##      ",
];

const HAND_COLORS: Record<string, number> = {
  "#": 0x18202c,
  ".": 0xffffff,
  c: COOP_PARTNER_CURSOR_TINT,
};

const RING_DOTS = 16;
const RING_RADIUS = 12;
/** The rings of the partner's ping: a lighter shade of the partner's cursor, to stand out on the dark screen */
const PARTNER_RING_COLOR = 0x9ad6ff;

/** Build the hand, its fingertip at the container's origin. */
function createHand(): Phaser.GameObjects.Container {
  const hand = globalScene.add.container(0, 0);
  const width = HAND[0].length;
  for (const [row, line] of HAND.entries()) {
    for (const [col, char] of [...line].entries()) {
      const color = HAND_COLORS[char];
      if (color !== undefined) {
        hand.add(
          globalScene.add.rectangle(col - Math.floor(width / 2) + 1, row - HAND.length, 1, 1, color).setOrigin(0),
        );
      }
    }
  }
  return hand;
}

/** A ring of dots around the origin. */
function createRing(color: number): Phaser.GameObjects.Container {
  const ring = globalScene.add.container(0, 0);
  for (let i = 0; i < RING_DOTS; i++) {
    const angle = (i / RING_DOTS) * Math.PI * 2;
    ring.add(
      globalScene.add.rectangle(Math.cos(angle) * RING_RADIUS, Math.sin(angle) * RING_RADIUS * 0.6, 2, 2, color),
    );
  }
  return ring;
}

export interface CoopPingMarkerOptions {
  /** Where the pinged choice's center is, in the parent's coordinates */
  x: number;
  y: number;
  /** How far above the center the fingertip points, in screen pixels */
  handOffset: number;
  /** Show the finger (the partner pinged); without it only the rings play once (the player's own ping) */
  withHand: boolean;
}

/**
 * Add an animated ping marker to `parent`.
 * @returns The marker; destroying it stops its animations. Without a hand it destroys itself once the rings fade.
 */
export function addCoopPingMarker(
  parent: Phaser.GameObjects.Container,
  name: string,
  { x, y, handOffset, withHand }: CoopPingMarkerOptions,
): Phaser.GameObjects.Container {
  // One unit of the marker is one screen pixel, so the pixel art stays crisp whatever the parent's scale
  const marker = globalScene.add.container(x, y).setScale(1 / (parent.scaleX || 1));
  marker.setName(name);
  const animated: Phaser.GameObjects.GameObject[] = [];

  const rings = [0, 1, 2].map(() => createRing(withHand ? PARTNER_RING_COLOR : 0xffffff));
  marker.add(rings);
  for (const [i, ring] of rings.entries()) {
    ring.setScale(0.2).setAlpha(0);
    animated.push(ring);
    globalScene.tweens.add({
      targets: ring,
      scale: { from: 0.2, to: 1.5 },
      alpha: { from: 1, to: 0 },
      ease: "Cubic.easeOut",
      duration: 650,
      delay: i * 180,
      repeat: withHand ? 2 : 0,
      ...(!withHand
        && i === rings.length - 1 && {
          onComplete: () => {
            if (marker.active) {
              marker.destroy();
            }
          },
        }),
    });
  }

  if (withHand) {
    const hand = createHand();
    const restY = -handOffset;
    hand.setY(restY - 14).setAlpha(0);
    marker.add(hand);
    animated.push(hand);
    globalScene.tweens.add({
      targets: hand,
      y: restY,
      alpha: 1,
      ease: "Bounce.easeOut",
      duration: 450,
      onComplete: () => {
        if (!hand.active) {
          return;
        }
        // Keeps pointing until the screen closes or the partner pings something else
        globalScene.tweens.add({
          targets: hand,
          y: restY - 3,
          ease: "Sine.easeInOut",
          duration: 380,
          yoyo: true,
          repeat: -1,
        });
      },
    });
  }

  marker.once("destroy", () => globalScene.tweens.killTweensOf(animated));
  parent.add(marker);
  return marker;
}
