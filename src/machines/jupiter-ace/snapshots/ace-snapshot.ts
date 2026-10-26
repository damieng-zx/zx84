/**
 * xAce / ACE32 `.ace` memory snapshots — the Jupiter Ace's community snapshot
 * format, which EightyOne and other Ace emulators also read.
 *
 * Layout (jupiter-ace.co.uk, "ACE snapshot format"): a dump of memory from
 * 0x2000 up to the top of RAM (0x3FFF, 0x7FFF or 0xBFFF), run-length
 * compressed with 0xED as the escape:
 *
 *   ED 00        end of data
 *   ED nn bb     nn copies of bb (an ED byte in the data is always written
 *                this way, even alone)
 *   anything else a literal byte
 *
 * The dump's first 1K (0x2000-0x23FF) is a mirror of video RAM, which the
 * emulator uses to hold its settings and the CPU: 32-bit little-endian words,
 * with RAMTOP at 0x2080 and the registers from 0x2100 — AF, BC, DE, HL, IX,
 * IY, SP, PC, AF', BC', DE', HL', IM, IFF1, IFF2, I, R.
 */

export interface AceRegisters {
  af: number; bc: number; de: number; hl: number;
  ix: number; iy: number; sp: number; pc: number;
  af_: number; bc_: number; de_: number; hl_: number;
  im: number; iff1: boolean; iff2: boolean; i: number; r: number;
}

export interface AceSnapshot {
  /** Memory from 0x2000 up, as the file holds it (its first 1K included). */
  readonly memory: Uint8Array;
  readonly regs: AceRegisters;
}

/** Largest dump: 0x2000-0xFFFF. */
const MAX_DUMP = 0xE000;

/** Decode an `.ace` file, or throw with a message fit to show. */
export function parseAceSnapshot(data: Uint8Array): AceSnapshot {
  const out = new Uint8Array(MAX_DUMP);
  let n = 0;
  let i = 0;
  let ended = false;
  while (i < data.length) {
    const b = data[i++];
    if (b !== 0xED) {
      if (n >= MAX_DUMP) throw new Error('Not a Jupiter Ace snapshot (too much data)');
      out[n++] = b;
      continue;
    }
    if (i >= data.length) break;
    const count = data[i++];
    if (count === 0) { ended = true; break; }
    if (i >= data.length) break;
    const value = data[i++];
    if (n + count > MAX_DUMP) throw new Error('Not a Jupiter Ace snapshot (too much data)');
    out.fill(value, n, n + count);
    n += count;
  }
  if (!ended) throw new Error('Jupiter Ace snapshot is truncated (no end marker)');
  // RAM is at least the 3K machine: the dump must reach 0x3FFF, and is
  // whole 16K steps above that (0x7FFF, 0xBFFF), or 0xFFFF for 51K.
  if (n !== 0x2000 && n !== 0x6000 && n !== 0xA000 && n !== 0xE000) {
    throw new Error(`Not a Jupiter Ace snapshot (${n} bytes of memory)`);
  }
  const mem = out.slice(0, n);
  const word = (addr: number): number => {
    const o = addr - 0x2000;
    return mem[o] | (mem[o + 1] << 8);
  };
  const regs: AceRegisters = {
    af: word(0x2100), bc: word(0x2104), de: word(0x2108), hl: word(0x210C),
    ix: word(0x2110), iy: word(0x2114), sp: word(0x2118), pc: word(0x211C),
    af_: word(0x2120), bc_: word(0x2124), de_: word(0x2128), hl_: word(0x212C),
    im: word(0x2130) & 3,
    iff1: word(0x2134) !== 0, iff2: word(0x2138) !== 0,
    i: word(0x213C) & 0xFF, r: word(0x2140) & 0xFF,
  };
  return { memory: mem, regs };
}
