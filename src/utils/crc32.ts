/**
 * CRC-32, the zip/PNG polynomial (reflected, initial value 0xFFFFFFFF,
 * final XOR 0xFFFFFFFF).
 *
 * One implementation for the whole codebase: the snapshot containers check
 * their bodies with it, PNG chunks carry it, and the tools that emit PNGs
 * compute it. It is pure and allocation-free, so a per-byte call is cheap.
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
