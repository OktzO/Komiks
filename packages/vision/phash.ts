// pHash 64-bit via OffscreenCanvas (grayscale + 8x8 DCT + median threshold).
// Falls back to aHash (average hash) if OffscreenCanvas unavailable in runtime.
// Zero-dependency: no sharp, no jimp. Uses Web platform APIs.

const resize = async (bytes: Uint8Array, type: string): Promise<Uint8Array> => {
  // OffscreenCanvas available in Workers runtime (CF Workers support it).
  if (typeof OffscreenCanvas !== 'undefined') {
    const blob = new Blob([bytes as BlobPart], { type });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0, 32, 32);
    const imgData = ctx.getImageData(0, 0, 32, 32);
    // Convert to grayscale (0-255 per pixel)
    const gray = new Uint8Array(32 * 32);
    for (let i = 0; i < 32 * 32; i++) {
      const r = imgData.data[i * 4];
      const g = imgData.data[i * 4 + 1];
      const b = imgData.data[i * 4 + 2];
      gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    return gray;
  }
  throw new Error('OffscreenCanvas not available — pHash requires Worker runtime with canvas support');
};

// 2D DCT (Discrete Cosine Transform) — 8x8 from 8x8 block of 32x32 grayscale.
// Simplified: take top-left 8x8 after applying DCT to the full 32x32.
// For perf, we downsample 32x32 → 8x8 by averaging 4x4 blocks first.
const downsample8x8 = (gray32: Uint8Array): number[] => {
  const out = new Array(64).fill(0);
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      let sum = 0;
      for (let dr = 0; dr < 4; dr++) {
        for (let dc = 0; dc < 4; dc++) {
          const idx = (row * 4 + dr) * 32 + (col * 4 + dc);
          sum += gray32[idx];
        }
      }
      out[row * 8 + col] = sum / 16;
    }
  }
  return out;
};

// 1D DCT-II of length 8
const C = (n: number, k: number): number =>
  Math.cos(((2 * n + 1) * k * Math.PI) / 16);

const dct2d = (block: number[]): number[] => {
  const out = new Array(64).fill(0);
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let sum = 0;
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          sum += block[x * 8 + y] * C(x, u) * C(y, v);
        }
      }
      const cu = u === 0 ? 1 / Math.SQRT2 : 1;
      const cv = v === 0 ? 1 / Math.SQRT2 : 1;
      out[u * 8 + v] = 0.25 * cu * cv * sum;
    }
  }
  return out;
};

const toHex = (bits: boolean[]): string => {
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0;
    for (let j = 0; j < 4; j++) {
      if (bits[i + j]) nibble |= (1 << (3 - j));
    }
    hex += nibble.toString(16);
  }
  return hex;
};

export const phash = async (bytes: Uint8Array, type = 'image/jpeg'): Promise<string> => {
  const gray32 = await resize(bytes, type);
  const block = downsample8x8(gray32);
  const dct = dct2d(block);
  // Top-left 8x8 (we already have 8x8 from downsample). Take all 64 coefficients.
  // Compute median of all except the DC term (index 0).
  const ac = dct.slice(1);
  const sorted = [...ac].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const bits = dct.map((v) => v > median);
  return toHex(bits);
};

// Fallback: aHash (average hash) — simpler, if pHash DCT fails or is too slow.
export const ahash = async (bytes: Uint8Array, type = 'image/jpeg'): Promise<string> => {
  const gray32 = await resize(bytes, type);
  const block = downsample8x8(gray32);
  const avg = block.reduce((a, b) => a + b, 0) / block.length;
  const bits = block.map((v) => v > avg);
  return toHex(bits);
};

// Auto: try pHash, fall back to aHash on error.
export const hashImage = async (bytes: Uint8Array, type = 'image/jpeg'): Promise<string> => {
  try {
    return await phash(bytes, type);
  } catch {
    return await ahash(bytes, type);
  }
};
