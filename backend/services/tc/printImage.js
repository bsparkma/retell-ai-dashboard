'use strict';

/**
 * A logo, as something a hand-rolled PDF can draw (CO-3).
 *
 * The print PDF follows services/hyg/slipPdf.js — written directly, no PDF
 * library — so the image has to arrive already in a shape a PDF image XObject
 * takes:
 *
 *   JPEG  embedded as it is (/DCTDecode). Only its size and colour components
 *         are read, from the frame header.
 *   PNG   decoded here (zlib + the five PNG row filters), then re-deflated as
 *         plain RGB or grey with any transparency as a separate soft mask.
 *         8-bit greyscale, RGB, grey+alpha and RGBA, and palette images at 1, 2,
 *         4 or 8 bits (with tRNS transparency). 16-bit and interlaced PNGs are
 *         REFUSED by name at upload, never half-drawn at print time.
 *
 * Only PNG and JPEG are accepted as logos. The type is decided from the BYTES,
 * never from a filename or a claimed content type.
 */

const zlib = require('node:zlib');

/** The largest logo, in pixels a side. */
const MAX_SIDE = 2048;

/** A refusal the upload route answers with by name. */
class LogoImageError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'LogoImageError';
    this.code = code;
  }
}

/** @param {Buffer} buf @returns {'image/png'|'image/jpeg'|null} */
function sniffLogoType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  return null;
}

/**
 * A JPEG's size and components, from its first SOF marker.
 * @param {Buffer} buf
 */
function readJpeg(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      const components = buf[i + 9];
      if (!width || !height || ![1, 3, 4].includes(components)) break;
      return { width, height, components };
    }
    i += 2 + len;
  }
  throw new LogoImageError('LOGO_IMAGE_UNREADABLE', 'That JPEG could not be read. Save it again as a standard JPEG or PNG.');
}

/** The PNG row filter's Paeth predictor. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decode a PNG to colour bytes (+ alpha bytes when it has transparency).
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, channels: 1|3, color: Buffer, alpha: Buffer|null }}
 */
function decodePng(buf) {
  let pos = 8;
  let ihdr = null;
  /** @type {Buffer[]} */
  const idat = [];
  let palette = null;
  let trns = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (data.length !== len) break;
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr || idat.length === 0 || !ihdr.width || !ihdr.height) {
    throw new LogoImageError('LOGO_IMAGE_UNREADABLE', 'That PNG could not be read. Save it again as a standard PNG or JPEG.');
  }
  const { width, height, bitDepth, colorType, interlace } = ihdr;
  const paletted = colorType === 3;
  if (interlace !== 0 || (paletted ? ![1, 2, 4, 8].includes(bitDepth) : bitDepth !== 8) || ![0, 2, 3, 4, 6].includes(colorType)) {
    throw new LogoImageError(
      'LOGO_IMAGE_FORMAT',
      'That PNG is 16-bit or interlaced, which the printout cannot use. Save it as an ordinary 8-bit PNG, or as a JPEG.'
    );
  }
  // A logo is drawn about an inch wide; 2048 a side is far more than it needs,
  // and keeps the synchronous decode below small.
  if (width > MAX_SIDE || height > MAX_SIDE) {
    throw new LogoImageError('LOGO_IMAGE_FORMAT', `That image is too large in pixels for a logo. Use one at most ${MAX_SIDE} pixels a side.`);
  }

  const samples = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bitsPerPixel = samples * bitDepth;
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  let raw;
  try {
    // BOUNDED: exactly what the header says the image is. A small file that
    // inflates past that (a "zip bomb") is refused, never allocated.
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: (stride + 1) * height });
  } catch {
    throw new LogoImageError('LOGO_IMAGE_UNREADABLE', 'That PNG could not be read. Save it again as a standard PNG or JPEG.');
  }
  if (raw.length < (stride + 1) * height) {
    throw new LogoImageError('LOGO_IMAGE_UNREADABLE', 'That PNG could not be read. Save it again as a standard PNG or JPEG.');
  }

  // Undo the row filters.
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? rows[dst + x - bpp] : 0;
      const b = y > 0 ? rows[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? rows[dst - stride + x - bpp] : 0;
      const v = raw[src + x];
      let out;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) out = v + paeth(a, b, c);
      else throw new LogoImageError('LOGO_IMAGE_UNREADABLE', 'That PNG could not be read. Save it again as a standard PNG or JPEG.');
      rows[dst + x] = out & 0xff;
    }
  }

  const n = width * height;
  if (paletted) {
    if (!palette) throw new LogoImageError('LOGO_IMAGE_UNREADABLE', 'That PNG could not be read. Save it again as a standard PNG or JPEG.');
    const color = Buffer.alloc(n * 3);
    const alpha = trns ? Buffer.alloc(n) : null;
    const perByte = 8 / bitDepth;
    const mask = (1 << bitDepth) - 1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = rows[y * stride + Math.floor(x / perByte)];
        const shift = 8 - bitDepth * ((x % perByte) + 1);
        const idx = bitDepth === 8 ? byte : (byte >> shift) & mask;
        const p = y * width + x;
        color[p * 3] = palette[idx * 3] ?? 0;
        color[p * 3 + 1] = palette[idx * 3 + 1] ?? 0;
        color[p * 3 + 2] = palette[idx * 3 + 2] ?? 0;
        if (alpha) alpha[p] = idx < trns.length ? trns[idx] : 255;
      }
    }
    return { width, height, channels: 3, color, alpha };
  }

  const colorChannels = colorType === 0 || colorType === 4 ? 1 : 3;
  const hasAlpha = colorType === 4 || colorType === 6;
  const color = Buffer.alloc(n * colorChannels);
  const alpha = hasAlpha ? Buffer.alloc(n) : null;
  for (let p = 0; p < n; p += 1) {
    const base = p * samples;
    for (let ch = 0; ch < colorChannels; ch += 1) color[p * colorChannels + ch] = rows[base + ch];
    if (alpha) alpha[p] = rows[base + samples - 1];
  }
  return { width, height, channels: /** @type {1|3} */ (colorChannels), color, alpha };
}

/**
 * The logo, prepared for the PDF writer: an image XObject's dictionary entries
 * and its (already encoded) stream, plus an optional soft mask.
 *
 * @param {Buffer} buf
 * @returns {{ width: number, height: number, dict: string, data: Buffer,
 *             smask: { dict: string, data: Buffer } | null }}
 * @throws {LogoImageError}
 */
function prepareLogo(buf) {
  if (!Buffer.isBuffer(buf)) throw new LogoImageError('LOGO_TYPE_NOT_ALLOWED', 'A logo must be a PNG or JPEG image.');
  const key = cacheKey(buf);
  const hit = cache.get(key);
  if (hit) return hit;
  // A refusal throws before this line, so only a good logo is ever cached.
  const prepared = prepareUncached(buf);
  cache.set(key, prepared);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return prepared;
}

/**
 * Prepared logos, by content hash: every print of an office's letter reuses
 * the decode instead of repeating it on the request thread. A handful of
 * offices × types, so a few entries.
 */
const CACHE_MAX = 8;
/** @type {Map<string, ReturnType<typeof prepareUncached>>} */
const cache = new Map();
function cacheKey(buf) {
  return require('node:crypto').createHash('sha256').update(buf).digest('hex');
}

/** @param {Buffer} buf */
function prepareUncached(buf) {
  const type = sniffLogoType(buf);
  if (type === 'image/jpeg') {
    const { width, height, components } = readJpeg(buf);
    const space = components === 1 ? '/DeviceGray' : components === 4 ? '/DeviceCMYK' : '/DeviceRGB';
    // Adobe CMYK JPEGs are stored inverted; the Decode array puts them right.
    const decode = components === 4 ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    return {
      width,
      height,
      dict: `/Width ${width} /Height ${height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /DCTDecode${decode}`,
      data: buf,
      smask: null,
    };
  }
  if (type === 'image/png') {
    const img = decodePng(buf);
    const space = img.channels === 1 ? '/DeviceGray' : '/DeviceRGB';
    // Fully opaque alpha is no alpha: skip the mask rather than carry one.
    const alpha = img.alpha && img.alpha.some((v) => v !== 255) ? img.alpha : null;
    return {
      width: img.width,
      height: img.height,
      dict: `/Width ${img.width} /Height ${img.height} /ColorSpace ${space} /BitsPerComponent 8 /Filter /FlateDecode`,
      data: zlib.deflateSync(img.color),
      smask: alpha
        ? {
            dict: `/Width ${img.width} /Height ${img.height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode`,
            data: zlib.deflateSync(alpha),
          }
        : null,
    };
  }
  throw new LogoImageError('LOGO_TYPE_NOT_ALLOWED', 'A logo must be a PNG or JPEG image.');
}

module.exports = { prepareLogo, sniffLogoType, decodePng, LogoImageError, MAX_SIDE };
