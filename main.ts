// THALVARA — a travel poster for a place that isn't there.
// main.ts — Node 22. Writes one image to /output/entry.png (1024 x 1024 PNG).
// No network, no dependencies, fully deterministic: the same run always
// paints the same poster, byte for byte.
//
// The place: Thalvara, a cliff town on a dusk coast where the sea climbs
// the sky — one great waterfall rising from the water into the evening air,
// a low sun, and a single sailboat for scale. The poster's name is set in
// large hand-drawn stroke lettering; the tagline is one short line.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32). No Math.random, no clock: run_deterministic.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261121);

// ---------------------------------------------------------------------------
// Canvas: a plain RGBA buffer with tiny raster helpers.
// ---------------------------------------------------------------------------
const W = 1024;
const H = 1024;
const buf = new Uint8Array(W * H * 4);

type RGBA = [number, number, number, number];

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Alpha-blend one pixel over what is already there.
function px(x: number, y: number, r: number, g: number, b: number, a: number): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H || a <= 0) return;
  const o = (iy * W + ix) * 4;
  if (a >= 1) {
    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
    return;
  }
  const inv = 1 - a;
  buf[o] = clamp255(r * a + buf[o] * inv);
  buf[o + 1] = clamp255(g * a + buf[o + 1] * inv);
  buf[o + 2] = clamp255(b * a + buf[o + 2] * inv);
  buf[o + 3] = 255;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGBA, c2: RGBA, t: number): RGBA {
  return [
    lerp(c1[0], c2[0], t),
    lerp(c1[1], c2[1], t),
    lerp(c1[2], c2[2], t),
    lerp(c1[3], c2[3], t),
  ];
}

// Filled disk with soft edge.
function disk(cx: number, cy: number, r: number, c: RGBA): void {
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
      if (d >= 1) continue;
      const edge = d > 0.85 ? (1 - d) / 0.15 : 1;
      px(x, y, c[0], c[1], c[2], c[3] * edge);
    }
  }
}

// Distance from point (x,y) to segment (x1,y1)-(x2,y2).
function segDist(x: number, y: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((x - x1) * dx + (y - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

// Thick line with round caps, drawn only inside its bounding box.
function thickLine(x1: number, y1: number, x2: number, y2: number, w: number, c: RGBA): void {
  const r = w / 2;
  const x0 = Math.max(0, Math.floor(Math.min(x1, x2) - r - 1));
  const x1b = Math.min(W - 1, Math.ceil(Math.max(x1, x2) + r + 1));
  const y0 = Math.max(0, Math.floor(Math.min(y1, y2) - r - 1));
  const y1b = Math.min(H - 1, Math.ceil(Math.max(y1, y2) + r + 1));
  for (let y = y0; y <= y1b; y++) {
    for (let x = x0; x <= x1b; x++) {
      const d = segDist(x + 0.5, y + 0.5, x1, y1, x2, y2);
      if (d >= r) continue;
      const edge = d > r - 1.5 ? (r - d) / 1.5 : 1;
      px(x, y, c[0], c[1], c[2], c[3] * edge);
    }
  }
}

// Filled polygon (even-odd scanline), with a soft alpha.
function polygon(points: Array<[number, number]>, c: RGBA): void {
  let minY = H - 1;
  let maxY = 0;
  for (const [, y] of points) {
    minY = Math.min(minY, Math.floor(y));
    maxY = Math.max(maxY, Math.ceil(y));
  }
  minY = Math.max(0, minY);
  maxY = Math.min(H - 1, maxY);
  const n = points.length;
  for (let y = minY; y <= maxY; y++) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % n];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        xs.push(x1 + ((y + 0.5 - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) px(x, y, c[0], c[1], c[2], c[3]);
    }
  }
}

// Cubic bezier point.
function bezier(
  p0: [number, number],
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  t: number,
): [number, number] {
  const u = 1 - t;
  const x =
    u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0];
  const y =
    u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1];
  return [x, y];
}

// ---------------------------------------------------------------------------
// PNG encoder: raw RGBA scanlines (filter 0) + zlib deflate + CRC32.
// ---------------------------------------------------------------------------
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcData = new Uint8Array(4 + data.length);
  crcData.set(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc32(crcData));
  return out;
}

function encodePNG(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width);
  iv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The poster scene. Composition (1024 x 1024):
//   sky    y 0..640   — deep indigo at the top melting into amber at the horizon
//   sea    y 640..1024 — dark teal with a column of sun-glitter
//   cliffs — dark silhouettes framing left and right
//   the landmark — one waterfall rising UP from the sea into the sky
//   type   — THALVARA across the upper sky, tagline beneath it
// ---------------------------------------------------------------------------

const HORIZON = 640;
const SUN_X = 655;
const SUN_Y = 628;

// Sky gradient stops: deep indigo -> violet -> rose -> amber.
const SKY: Array<[number, RGBA]> = [
  [0.0, [22, 28, 58, 1]],
  [0.32, [52, 44, 96, 1]],
  [0.55, [122, 66, 110, 1]],
  [0.74, [214, 110, 84, 1]],
  [0.88, [246, 168, 92, 1]],
  [1.0, [255, 205, 130, 1]],
];

function skyColor(t: number): RGBA {
  for (let i = 1; i < SKY.length; i++) {
    if (t <= SKY[i][0]) {
      const [t0, c0] = SKY[i - 1];
      const [t1, c1] = SKY[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return SKY[SKY.length - 1][1];
}

function paintSkyAndSea(): void {
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (y < HORIZON) {
        const c = skyColor(y / HORIZON);
        const o = (y * W + x) * 4;
        buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 255;
      } else {
        // Sea: deep teal that darkens toward the bottom, with a warm
        // reflection column under the sun.
        const t = (y - HORIZON) / (H - HORIZON);
        let r = lerp(28, 10, t);
        let g = lerp(64, 26, t);
        let b = lerp(88, 44, t);
        const dSun = Math.abs(x - SUN_X);
        const glitter = Math.max(0, 1 - dSun / 150) * (0.55 + 0.45 * Math.sin(y * 0.55 + x * 0.02));
        const warm = Math.max(0, 1 - t * 1.6);
        r = lerp(r, 250, glitter * warm * 0.55);
        g = lerp(g, 170, glitter * warm * 0.5);
        b = lerp(b, 95, glitter * warm * 0.45);
        const o = (y * W + x) * 4;
        buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255;
      }
    }
  }
  // Thin bright horizon line.
  for (let x = 0; x < W; x++) px(x, HORIZON, 255, 214, 150, 0.9);
}

function paintSun(): void {
  // Wide soft glow, then a solid low disc half-sunk at the horizon.
  for (let r = 260; r > 0; r -= 8) {
    const a = 0.05 * (1 - r / 260);
    disk(SUN_X, SUN_Y, r, [255, 178, 105, a]);
  }
  disk(SUN_X, SUN_Y, 74, [255, 214, 150, 1]);
  disk(SUN_X, SUN_Y, 58, [255, 232, 178, 1]);
  disk(SUN_X, SUN_Y, 40, [255, 244, 205, 1]);
}

function paintStars(): void {
  for (let i = 0; i < 150; i++) {
    const x = rand() * W;
    const y = rand() * 430;
    const fade = 1 - y / 470; // stars only high up, fading toward the dusk band
    const s = rand();
    const r = s < 0.75 ? 1 : s < 0.95 ? 1.6 : 2.4;
    px(x, y, 255, 240, 210, 0.85 * fade);
    if (r > 1.4) {
      px(x + 1, y, 255, 240, 210, 0.5 * fade);
      px(x, y + 1, 255, 240, 210, 0.5 * fade);
    }
    if (r > 2) disk(x, y, 2.2, [255, 240, 210, 0.35 * fade]);
  }
}

function paintCliffs(): void {
  // Left headland: a dark silhouette rising from the sea's edge.
  polygon(
    [
      [0, 1024], [0, 760], [52, 726], [118, 700], [176, 668], [228, 676],
      [268, 706], [292, 760], [300, 830], [296, 1024],
    ],
    [16, 22, 42, 1],
  );
  // Right headland, taller, with a flat top where a tiny watch-tower stands.
  polygon(
    [
      [1024, 1024], [1024, 700], [968, 668], [908, 640], [856, 652],
      [812, 690], [782, 760], [776, 830], [790, 1024],
    ],
    [13, 19, 38, 1],
  );
  // Watch-tower on the right cliff: one small lit window, a place to stay.
  polygon([[896, 640], [896, 596], [930, 596], [930, 640]], [13, 19, 38, 1]);
  polygon([[890, 600], [936, 600], [928, 586], [898, 586]], [13, 19, 38, 1]);
  px(911, 612, 255, 210, 120, 1);
  px(912, 612, 255, 210, 120, 1);
  px(911, 613, 255, 210, 120, 1);
  px(912, 613, 255, 210, 120, 1);
  disk(913, 612, 7, [255, 200, 110, 0.25]);
}

function paintBirds(): void {
  const birds: Array<[number, number, number]> = [
    [180, 210, 16], [236, 176, 12], [300, 232, 14],
    [820, 300, 13], [872, 262, 10], [760, 340, 11],
  ];
  for (const [x, y, s] of birds) {
    // A bird is two short strokes meeting in a shallow V.
    thickLine(x - s, y, x, y + s * 0.45, 3, [24, 28, 52, 0.85]);
    thickLine(x, y + s * 0.45, x + s, y, 3, [24, 28, 52, 0.85]);
  }
}

// The landmark: the sea climbing the sky. A broad ribbon of water arcs up
// from the surface at the horizon, thinning as it rises, with a bright core
// and spray where it leaves the sea and where it dissolves into the dusk.
function paintWaterfall(): void {
  const p0: [number, number] = [668, 648];
  const p1: [number, number] = [724, 470];
  const p2: [number, number] = [600, 345];
  const p3: [number, number] = [455, 235];
  const N = 60;
  let prev: [number, number] | null = null;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const pt = bezier(p0, p1, p2, p3, t);
    const width = lerp(64, 16, t);
    if (prev) {
      const body = mix([86, 158, 196, 0.95], [232, 244, 252, 0.98], t);
      thickLine(prev[0], prev[1], pt[0], pt[1], width, body);
      const core = mix([190, 224, 240, 0.95], [255, 255, 255, 1], t);
      thickLine(prev[0], prev[1], pt[0], pt[1], width * 0.42, core);
    }
    prev = pt;
  }
  // Spray: droplets thrown off the ribbon, denser near the sea.
  for (let i = 0; i < 260; i++) {
    const t = rand();
    const pt = bezier(p0, p1, p2, p3, t);
    const spread = lerp(46, 14, t) * (0.4 + rand() * 0.9);
    const sx = pt[0] + (rand() - 0.5) * 2 * spread;
    const sy = pt[1] + (rand() - 0.5) * 2 * spread * 0.7;
    const a = (1 - t * 0.6) * (0.35 + rand() * 0.5);
    disk(sx, sy, 1 + rand() * 2.4, [225, 240, 250, a]);
  }
  // Foam ring where the water leaves the sea.
  for (let i = 0; i < 90; i++) {
    const a = rand() * Math.PI * 2;
    const r = 26 + rand() * 66;
    const x = 668 + Math.cos(a) * r * 1.5;
    const y = 652 + Math.abs(Math.sin(a)) * r * 0.35 - 4;
    disk(x, y, 1.5 + rand() * 3, [235, 246, 252, 0.35 + rand() * 0.45]);
  }
  // A pale mist where the ribbon dissolves, just beneath the place's name.
  disk(455, 235, 34, [240, 226, 240, 0.14]);
  disk(455, 235, 20, [250, 240, 248, 0.18]);
}

function paintBoat(): void {
  // One small sailboat on the glitter path, for scale and for the promise
  // of a stay: someone is already out there, sailing toward the falls.
  const x = 470;
  const y = 742;
  polygon([[x - 26, y], [x + 26, y], [x + 16, y + 12], [x - 16, y + 12]], [12, 18, 36, 1]);
  thickLine(x, y - 2, x, y - 52, 3, [12, 18, 36, 1]);
  polygon([[x + 3, y - 50], [x + 3, y - 6], [x + 34, y - 6]], [255, 238, 205, 0.96]);
  polygon([[x - 3, y - 42], [x - 3, y - 6], [x - 24, y - 6]], [255, 214, 150, 0.9]);
  disk(x, y + 16, 10, [255, 200, 110, 0.18]);
}

// ---------------------------------------------------------------------------
// Stroke lettering. Each glyph is a set of polylines on a 10 x 14 grid
// (x 0..10, y 0..14, top to baseline). Single-stroke poster capitals,
// drawn thick so they read as set type, not as an afterthought.
// Only the letters the poster needs are defined.
// ---------------------------------------------------------------------------
type Stroke = Array<[number, number]>;
const GLYPHS: Record<string, Stroke[]> = {
  A: [[[0, 14], [5, 0], [10, 14]], [[2.6, 8], [7.4, 8]]],
  B: [
    [[0, 0], [0, 14]],
    [[0, 0], [6.5, 0], [9, 2], [6.5, 5], [0, 5]],
    [[0, 5], [7.5, 5], [10, 8], [7.5, 11.5], [6, 14], [0, 14]],
  ],
  C: [[[9, 2.5], [5, 0], [1.5, 2], [0, 7], [1.5, 12], [5, 14], [9, 11.5]]],
  E: [[[9, 0], [0, 0], [0, 14], [9, 14]], [[0, 7], [6, 7]]],
  H: [[[0, 0], [0, 14]], [[10, 0], [10, 14]], [[0, 7], [10, 7]]],
  I: [[[5, 0], [5, 14]], [[2, 0], [8, 0]], [[2, 14], [8, 14]]],
  K: [[[0, 0], [0, 14]], [[9.5, 0], [0.5, 7], [9.5, 14]]],
  L: [[[0, 0], [0, 14], [9.5, 14]]],
  M: [[[0, 14], [0, 0], [5, 8], [10, 0], [10, 14]]],
  R: [
    [[0, 14], [0, 0], [6.5, 0], [9, 2], [6.5, 5], [0, 5]],
    [[5, 5.5], [10, 14]],
  ],
  S: [[[9, 2.5], [6, 0], [2.5, 0], [0, 3], [2, 6.5], [6.5, 7.5], [9.5, 9], [9.5, 11.5], [7, 14], [2.5, 14], [0.5, 11.5]]],
  T: [[[0, 0], [10, 0]], [[5, 0], [5, 14]]],
  V: [[[0, 0], [5, 14], [10, 0]]],
  W: [[[0, 0], [2.2, 14], [5, 7], [7.8, 14], [10, 0]]],
  Y: [[[0, 0], [5, 7], [10, 0]], [[5, 7], [5, 14]]],
};

function glyphWidth(ch: string): number {
  return ch === " " ? 6 : 10;
}

// Draw one line of stroke text, centred on cx, cap-height `size`, with
// `tracking` extra space between glyphs. Returns the width it occupied.
function drawText(
  text: string,
  cx: number,
  top: number,
  size: number,
  weight: number,
  color: RGBA,
  tracking: number,
): number {
  const scale = size / 14;
  const adv = (ch: string): number => (glyphWidth(ch) + tracking) * scale;
  let total = 0;
  for (const ch of text) total += adv(ch);
  total -= tracking * scale;
  let x = cx - total / 2;
  for (const ch of text) {
    if (ch !== " ") {
      const strokes = GLYPHS[ch];
      if (strokes) {
        for (const stroke of strokes) {
          for (let i = 0; i + 1 < stroke.length; i++) {
            const [sx1, sy1] = stroke[i];
            const [sx2, sy2] = stroke[i + 1];
            thickLine(
              x + sx1 * scale, top + sy1 * scale,
              x + sx2 * scale, top + sy2 * scale,
              weight, color,
            );
          }
        }
      }
    }
    x += adv(ch);
  }
  return total;
}

function paintType(): void {
  const cream: RGBA = [255, 233, 196, 1];
  const shadow: RGBA = [16, 20, 44, 0.55];
  // Soft shadow first, then the face: the name sits on the dusk sky.
  drawText("THALVARA", W / 2 + 4, 96 + 5, 118, 15, shadow, 2.2);
  drawText("THALVARA", W / 2, 96, 118, 15, cream, 2.2);
  // A hairline rule, then one short line that says what a stay feels like.
  const ruleY = 252;
  thickLine(W / 2 - 130, ruleY, W / 2 + 130, ruleY, 3, [255, 233, 196, 0.85]);
  disk(W / 2, ruleY, 5, [255, 233, 196, 0.95]);
  drawText("WHERE THE SEA CLIMBS THE SKY", W / 2 + 2, 276 + 3, 34, 5.5, shadow, 1.6);
  drawText("WHERE THE SEA CLIMBS THE SKY", W / 2, 276, 34, 5.5, [255, 226, 180, 1], 1.6);
}

function paintFrame(): void {
  // A quiet double hairline, the way a printed travel poster is bordered.
  const m = 26;
  const c: RGBA = [255, 233, 196, 0.5];
  thickLine(m, m, W - m, m, 2, c);
  thickLine(m, H - m, W - m, H - m, 2, c);
  thickLine(m, m, m, H - m, 2, c);
  thickLine(W - m, m, W - m, H - m, 2, c);
  const m2 = 34;
  const c2: RGBA = [255, 233, 196, 0.28];
  thickLine(m2, m2, W - m2, m2, 1.5, c2);
  thickLine(m2, H - m2, W - m2, H - m2, 1.5, c2);
  thickLine(m2, m2, m2, H - m2, 1.5, c2);
  thickLine(W - m2, m2, W - m2, H - m2, 1.5, c2);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
function main(): void {
  paintSkyAndSea();
  paintSun();
  paintStars();
  paintWaterfall();
  paintCliffs();
  paintBoat();
  paintBirds();
  paintType();
  paintFrame();
  const png = encodePNG(W, H, buf);
  mkdirSync("/output", { recursive: true });
  writeFileSync("/output/entry.png", png);
  console.log(`wrote /output/entry.png (${png.length} bytes, ${W}x${H})`);
}

main();
