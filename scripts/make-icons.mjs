// Generates the four toolbar/manifest icons from code, so the artwork is reproducible and reviewable and
// the repository carries no binary source of truth. Pure Node: zlib for the PNG stream, no dependencies.
//
//   npm run icons      →   icons/icon16.png, icon32.png, icon48.png, icon128.png
//
// The mark is a chat bubble with two code lines inside it: a conversation driven from a panel, on a slate
// tile that reads clearly at 16 px.
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const SIZES = [16, 32, 48, 128];

// ---------- png encoding ----------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function encodePng(size, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // One filter byte (0 = none) per row, then the raw RGBA row.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ---------- drawing ---------------------------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => (t < 0 ? 0 : t > 1 ? 1 : t);
const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
// Signed distance helpers, in unit-square coordinates (0..1).
const roundedBox = (x, y, cx, cy, halfW, halfH, radius) => {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) - radius;
};
const coverage = (distance, feather) => clamp01(0.5 - distance / (2 * feather));

const TILE_TOP = [63, 79, 96, 255];      // slate
const TILE_BOTTOM = [24, 30, 38, 255];
const BUBBLE = [245, 247, 250, 255];
const LINE = [30, 41, 52, 255];
const CARET = [13, 148, 136, 255];      // teal, matching the panel's default accent family

function sample(u, v, size) {
  const feather = 1 / size; // one device pixel of anti-aliasing
  // Tile: a rounded square covering the canvas with a small margin so the icon never touches the edge.
  const margin = size <= 16 ? 0.02 : 0.04;
  const half = 0.5 - margin;
  const radius = size <= 16 ? 0.24 : 0.26;
  const tile = coverage(roundedBox(u, v, 0.5, 0.5, half, half, radius), feather);
  if (tile <= 0) return [0, 0, 0, 0];
  const gradient = mix(TILE_TOP, TILE_BOTTOM, clamp01((v - margin) / (1 - 2 * margin)));

  // Bubble: a rounded rect with a small tail at the bottom-left.
  const bubbleBox = coverage(roundedBox(u, v, 0.5, 0.455, 0.30, 0.215, 0.115), feather);
  const tail = coverage(roundedBox(u, v, 0.345, 0.685, 0.055, 0.055, 0.02), feather)
    * coverage(roundedBox(u, v, 0.345, 0.63, 0.06, 0.06, 0.02), feather);
  const bubble = clamp01(bubbleBox + tail);

  // Two code lines inside the bubble; at 16 px only the longer one survives the feathering.
  const lineAlpha = size <= 16 ? 0 : 1;
  const lineA = coverage(roundedBox(u, v, 0.47, 0.40, 0.185, 0.028, 0.028), feather);
  const lineB = coverage(roundedBox(u, v, 0.42, 0.51, 0.135, 0.028, 0.028), feather) * lineAlpha;
  const caret = coverage(roundedBox(u, v, 0.615, 0.51, 0.022, 0.032, 0.012), feather) * lineAlpha;

  let pixel = gradient;
  pixel = mix(pixel, BUBBLE, bubble);
  pixel = mix(pixel, LINE, clamp01(lineA + lineB));
  pixel = mix(pixel, CARET, caret);
  return [pixel[0], pixel[1], pixel[2], 255 * tile];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = size <= 48 ? 3 : 2; // supersampling: small sizes need more help to stay crisp
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / size;
          const v = (y + (sy + 0.5) / samples) / size;
          const [sr, sg, sb, sa] = sample(u, v, size);
          const weight = sa / 255;
          // Premultiply, average, then un-premultiply: the standard way to avoid dark fringes.
          r += sr * weight; g += sg * weight; b += sb * weight; a += sa;
        }
      }
      const total = samples * samples;
      const alpha = a / total;
      const index = (y * size + x) * 4;
      pixels[index] = alpha > 0 ? Math.round(r / (alpha / 255) / total) : 0;
      pixels[index + 1] = alpha > 0 ? Math.round(g / (alpha / 255) / total) : 0;
      pixels[index + 2] = alpha > 0 ? Math.round(b / (alpha / 255) / total) : 0;
      pixels[index + 3] = Math.round(alpha);
    }
  }
  return encodePng(size, pixels);
}

const output = resolve(root, 'icons');
await mkdir(output, { recursive: true });
for (const size of SIZES) {
  const target = resolve(output, `icon${size}.png`);
  if (!target.startsWith(dirname(output))) throw new Error('Icon path escaped the repository');
  await writeFile(target, render(size));
  console.log(`wrote icons/icon${size}.png`);
}
