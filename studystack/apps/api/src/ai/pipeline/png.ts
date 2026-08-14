// ── PNG encoder (minimal, dependency-free) ─────────────────────────────
// Encodes raw RGBA pixels to PNG so scanned PDF pages can be fed to
// Tesseract without pulling in a native canvas dependency. Uses only
// node:zlib.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/**
 * Encodes raw pixel data as a PNG buffer. Accepts 1 (gray), 3 (RGB) or
 * 4 (RGBA) channels; gray/RGB inputs are expanded to RGBA so the encoder
 * stays a single code path.
 */
export function encodePng(
  data: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: 1 | 3 | 4,
): Buffer {
  const expected = width * height * channels;
  if (data.length !== expected) {
    throw new Error(
      `PNG encode: expected ${expected} bytes, got ${data.length}`,
    );
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  if (channels === 4) {
    rgba.set(data);
  } else if (channels === 3) {
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      rgba[j] = data[i];
      rgba[j + 1] = data[i + 1];
      rgba[j + 2] = data[i + 2];
      rgba[j + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0; i < data.length; i++, j += 4) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = data[i];
      rgba[j + 3] = 255;
    }
  }
  return encodePngRgba(rgba, width, height);
}

/** Encodes RGBA pixel data (row-major) as a PNG buffer. */
export function encodePngRgba(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Buffer {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(
      `PNG encode: expected ${expected} bytes, got ${rgba.length}`,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  // compression / filter / interlace = 0

  // IDAT: each scanline prefixed with filter byte 0.
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(
      Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4),
      y * (width * 4 + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
