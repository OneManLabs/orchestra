import { deflateSync } from 'node:zlib';
import { trayIconBitmap, type MenuBarVisualState } from './menu-bar.js';

export interface TrayIconPngRepresentation {
  scaleFactor: 1 | 2;
  width: number;
  height: number;
  png: Buffer;
  dataUrl: string;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = createCrcTable();

/**
 * Produce documented, portable PNG representations for a macOS template
 * image. The raster source is converted explicitly to black RGBA pixels so
 * Electron never has to interpret hand-authored platform-dependent bitmaps.
 */
export function createTrayIconPngRepresentations(state: MenuBarVisualState): readonly [
  TrayIconPngRepresentation,
  TrayIconPngRepresentation
] {
  return [
    createRepresentation(state, 1),
    createRepresentation(state, 2)
  ];
}

export function encodeTrayIconPng(state: MenuBarVisualState, scaleFactor: 1 | 2): Buffer {
  const size = 19 * scaleFactor;
  const platformBitmap = trayIconBitmap(state, scaleFactor);
  const rgba = Buffer.alloc(size * size * 4);
  for (let index = 0; index < platformBitmap.length; index += 4) {
    // macOS template images derive their tint from alpha. Writing RGB
    // explicitly avoids depending on createFromBitmap's platform format.
    rgba[index] = 0;
    rgba[index + 1] = 0;
    rgba[index + 2] = 0;
    rgba[index + 3] = platformBitmap[index + 3]!;
  }
  return encodeRgbaPng(size, size, rgba);
}

export function encodeRgbaPng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 4_096 || height > 4_096) {
    throw new Error('PNG dimensions must be positive integers no larger than 4096.');
  }
  const expectedLength = width * height * 4;
  if (rgba.byteLength !== expectedLength) throw new Error(`RGBA buffer must contain exactly ${expectedLength} bytes.`);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolor with alpha
  ihdr[10] = 0; // DEFLATE compression
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const destination = row * (stride + 1);
    scanlines[destination] = 0; // deterministic "None" filter
    scanlines.set(rgba.subarray(row * stride, (row + 1) * stride), destination + 1);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function createRepresentation(state: MenuBarVisualState, scaleFactor: 1 | 2): TrayIconPngRepresentation {
  const png = encodeTrayIconPng(state, scaleFactor);
  const size = 19 * scaleFactor;
  return {
    scaleFactor,
    width: size,
    height: size,
    png,
    dataUrl: `data:image/png;base64,${png.toString('base64')}`
  };
}

function pngChunk(type: string, data: Buffer): Buffer {
  if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG chunk type must contain four ASCII letters.');
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
