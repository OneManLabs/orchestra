import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  createTrayIconPngRepresentations,
  encodeRgbaPng,
  encodeTrayIconPng
} from '../src/main/tray-icon-png.js';

interface ParsedPng {
  width: number;
  height: number;
  rgba: Buffer;
  chunkTypes: string[];
}

describe('tray PNG representations', () => {
  it('creates deterministic 1x and 2x standards-compliant RGBA PNGs', () => {
    const representations = createTrayIconPngRepresentations('critical');
    expect(representations.map(({ scaleFactor, width, height }) => ({ scaleFactor, width, height }))).toEqual([
      { scaleFactor: 1, width: 19, height: 19 },
      { scaleFactor: 2, width: 38, height: 38 }
    ]);

    for (const representation of representations) {
      const parsed = parsePng(representation.png);
      expect(parsed).toMatchObject({
        width: representation.width,
        height: representation.height,
        chunkTypes: ['IHDR', 'IDAT', 'IEND']
      });
      expect(representation.dataUrl).toBe(`data:image/png;base64,${representation.png.toString('base64')}`);
      expect(parsed.rgba.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
      expect(parsed.rgba.every((value, index) => index % 4 === 3 || value === 0)).toBe(true);
    }

    expect(createTrayIconPngRepresentations('critical')[1].png.equals(representations[1].png)).toBe(true);
  });

  it('keeps every visual state distinct in encoded form', () => {
    const states = ['healthy', 'activity', 'warning', 'critical', 'disconnected'] as const;
    const values = states.map((state) => encodeTrayIconPng(state, 2).toString('base64'));
    expect(new Set(values).size).toBe(states.length);
  });

  it('round-trips exact RGBA scanlines with deterministic filter bytes', () => {
    const rgba = Buffer.from([
      0, 0, 0, 0,
      0, 0, 0, 255,
      0, 0, 0, 127,
      0, 0, 0, 64
    ]);
    const parsed = parsePng(encodeRgbaPng(2, 2, rgba));
    expect(parsed.rgba).toEqual(rgba);
  });

  it('rejects malformed dimensions and pixel buffers', () => {
    expect(() => encodeRgbaPng(0, 1, new Uint8Array())).toThrow('dimensions');
    expect(() => encodeRgbaPng(4_097, 1, new Uint8Array())).toThrow('dimensions');
    expect(() => encodeRgbaPng(2, 2, new Uint8Array(15))).toThrow('exactly 16 bytes');
  });
});

function parsePng(png: Buffer): ParsedPng {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const chunkTypes: string[] = [];
  const idat: Buffer[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = png.readUInt32BE(offset + 8 + length);
    expect(expectedCrc).toBe(testCrc32(png.subarray(offset + 4, offset + 8 + length)));
    chunkTypes.push(type);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([...data.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    } else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const scanlines = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const source = row * (stride + 1);
    expect(scanlines[source]).toBe(0);
    scanlines.copy(rgba, row * stride, source + 1, source + 1 + stride);
  }
  return { width, height, rgba, chunkTypes };
}

function testCrc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
