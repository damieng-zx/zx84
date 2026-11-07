/**
 * Build `.crt` files by hand, the way the cartridge file format lays them out
 * (a 64-byte header, then one CHIP packet per ROM), so the tests have
 * cartridges whose contents they know to the byte.
 */

export interface CrtChip {
  readonly bank: number;
  readonly load: number;
  readonly data: Uint8Array;
}

export function buildCrt(hw: number, exrom: number, game: number, chips: readonly CrtChip[], name = 'TEST'): Uint8Array {
  const parts: Uint8Array[] = [];
  const header = new Uint8Array(0x40);
  header.set([...'C64 CARTRIDGE   '].map(c => c.charCodeAt(0)), 0);
  header.set([0, 0, 0, 0x40, 0x01, 0x00, hw >> 8, hw & 0xFF, exrom, game], 0x10);
  header.set([...name].map(c => c.charCodeAt(0)), 0x20);
  parts.push(header);
  for (const chip of chips) {
    const p = new Uint8Array(0x10 + chip.data.length);
    p.set([...'CHIP'].map(c => c.charCodeAt(0)), 0);
    const total = p.length;
    p.set([total >>> 24, (total >> 16) & 0xFF, (total >> 8) & 0xFF, total & 0xFF], 4);
    p.set([0, 0, chip.bank >> 8, chip.bank & 0xFF, chip.load >> 8, chip.load & 0xFF, chip.data.length >> 8, chip.data.length & 0xFF], 8);
    p.set(chip.data, 0x10);
    parts.push(p);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** An 8K ROM whose every byte is `fill`, with `bytes` placed from `at`. */
export function rom8k(fill: number, bytes: ReadonlyArray<readonly [number, readonly number[]]> = []): Uint8Array {
  const d = new Uint8Array(0x2000).fill(fill);
  for (const [at, b] of bytes) d.set(b, at);
  return d;
}
