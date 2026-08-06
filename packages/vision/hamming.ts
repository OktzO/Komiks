// Hamming distance between two 16-char hex strings (64-bit pHash).
// Each hex char = 4 bits. We compute popcount of XOR per nibble.
const NIBBLE_POPCOUNT: Record<string, number> = {
  '0': 0, '1': 1, '2': 1, '3': 2,
  '4': 1, '5': 2, '6': 2, '7': 3,
  '8': 1, '9': 2, 'a': 2, 'b': 3,
  'c': 2, 'd': 3, 'e': 3, 'f': 4,
};

export const hammingDistance = (a: string, b: string): number => {
  if (a.length !== b.length) return 64;
  let dist = 0;
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  for (let i = 0; i < aLower.length; i++) {
    const xor = (parseInt(aLower[i], 16) ^ parseInt(bLower[i], 16)).toString(16);
    dist += NIBBLE_POPCOUNT[xor] ?? 4;
  }
  return dist;
};
