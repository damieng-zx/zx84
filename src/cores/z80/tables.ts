// Pre-computed flag tables — eliminates per-call bit math in ALU ops.
// SZ[i]: Sign | Zero | undocumented bits 3,5
// SZP[i]: SZ[i] with parity bit (0x04) added
export const SZ = new Uint8Array(256);
export const SZP = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const s = i & 0x80;
  const z = i === 0 ? 0x40 : 0;
  const u = i & 0x28;
  SZ[i] = s | z | u;
  let p = i;
  p ^= p >> 4;
  p ^= p >> 2;
  p ^= p >> 1;
  SZP[i] = s | z | u | ((p & 1) === 0 ? 0x04 : 0);
}

// Opcodes that reference H, L, or HL and should be remapped by DD/FD prefix.
// Opcodes NOT in this set execute normally (prefix ignored, just adds 4 T-states).
const _ddfdHL = new Uint8Array(256);
(() => {
  // 16-bit HL: ADD HL,rr / INC HL / DEC HL / LD HL,nn / LD (nn),HL / LD HL,(nn) / LD SP,HL
  for (const op of [0x09, 0x19, 0x29, 0x39, 0x21, 0x22, 0x23, 0x2A, 0x2B, 0xF9]) _ddfdHL[op] = 1;
  // PUSH/POP HL, EX (SP),HL, JP (HL)
  for (const op of [0xE1, 0xE3, 0xE5, 0xE9]) _ddfdHL[op] = 1;
  // 8-bit H/L: INC/DEC H/L
  for (const op of [0x24, 0x25, 0x2C, 0x2D]) _ddfdHL[op] = 1;
  // LD r,H / LD r,L (x=1, z=4 or z=5, y!=6)
  for (let y = 0; y < 8; y++) {
    if (y === 6) continue;
    _ddfdHL[0x40 | (y << 3) | 4] = 1; // LD r,H
    _ddfdHL[0x40 | (y << 3) | 5] = 1; // LD r,L
  }
  // LD H,r / LD L,r (x=1, y=4 or y=5, z!=6)
  for (let z = 0; z < 8; z++) {
    if (z === 6) continue;
    _ddfdHL[0x40 | (4 << 3) | z] = 1; // LD H,r
    _ddfdHL[0x40 | (5 << 3) | z] = 1; // LD L,r
  }
  // ALU A,H / ALU A,L (x=2, z=4 or z=5)
  for (let y = 0; y < 8; y++) {
    _ddfdHL[0x80 | (y << 3) | 4] = 1; // ALU A,H
    _ddfdHL[0x80 | (y << 3) | 5] = 1; // ALU A,L
  }
  // LD H,n / LD L,n
  _ddfdHL[0x26] = 1;
  _ddfdHL[0x2E] = 1;
})();

export function ddfdUsesHL(op: number): boolean { return _ddfdHL[op] !== 0; }
