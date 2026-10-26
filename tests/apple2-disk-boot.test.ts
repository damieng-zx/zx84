/**
 * Headless Disk ][ boots through the real CPU.
 *
 * No Apple ROM or disk is in the repo, so the boot code is our own: a 6502
 * loader written here, in the style of the Disk II boot ROM and DOS's RWTS. It
 * reads the disk the way they do — cycle-counted `LDA $C08C,X / BPL` polling
 * loops, a recognition of `D5 AA 96` and `D5 AA AD` with the classic NOP pacing
 * between bytes, 343 data nibbles grabbed at full speed and denibblized
 * afterwards, the stepper driven phase by phase — and loads tracks 0-2 (48
 * sectors) into $1000-$3FFF, then jumps into the first sector like the boot ROM
 * jumps to $0801. The same disk is booted as a `.dsk`, a `.po`, a `.nib` built
 * with the plain nibble encoder, a `.2mg`, and a WOZ 2 file assembled here from
 * the spec's layout.
 *
 * The denibblizing table and the 6-and-2 layout are the published ones (see
 * apple2-disk.test.ts); the expected memory is the sector data itself.
 */

import { describe, expect, it } from 'vitest';
import { crc32 } from 'node:zlib';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import {
  DOS_SKEW, GCR_READ_TABLE, encodeTrack, parseApple2Disk, serializeApple2Disk,
} from '@/media/floppy/apple2.ts';
import { encodeTrackBits, standardTmap } from '@/media/floppy/apple2-bitstream.ts';

// ── A minimal two-pass 6502 assembler ─────────────────────────────────────

type Mode = 'imp' | 'imm' | 'zp' | 'abs' | 'rel';
const OPS: Record<string, [number, Mode]> = {
  'LDA#': [0xA9, 'imm'], 'LDAz': [0xA5, 'zp'], 'LDA': [0xAD, 'abs'], 'LDA,X': [0xBD, 'abs'],
  'LDA,Y': [0xB9, 'abs'], 'LDAz,X': [0xB5, 'zp'],
  'STAz': [0x85, 'zp'], 'STA,X': [0x9D, 'abs'], 'STA,Y': [0x99, 'abs'], 'STA(),Y': [0x91, 'zp'],
  'STAz,X': [0x95, 'zp'],
  'LDX#': [0xA2, 'imm'], 'LDXz': [0xA6, 'zp'], 'LDX,Y': [0xBE, 'abs'], 'LDY#': [0xA0, 'imm'],
  'TAX': [0xAA, 'imp'], 'INY': [0xC8, 'imp'], 'DEY': [0x88, 'imp'], 'DEX': [0xCA, 'imp'],
  'INCz': [0xE6, 'zp'], 'CMP#': [0xC9, 'imm'], 'CMPz': [0xC5, 'zp'], 'CPY#': [0xC0, 'imm'],
  'EORz': [0x45, 'zp'], 'AND#': [0x29, 'imm'], 'ANDz': [0x25, 'zp'], 'ORA#': [0x09, 'imm'],
  'ORAz': [0x05, 'zp'], 'ADC#': [0x69, 'imm'], 'ADCz': [0x65, 'zp'],
  'ASL': [0x0A, 'imp'], 'ROL': [0x2A, 'imp'], 'LSR,X': [0x5E, 'abs'],
  'CLC': [0x18, 'imp'], 'SEC': [0x38, 'imp'],
  'BNE': [0xD0, 'rel'], 'BEQ': [0xF0, 'rel'], 'BPL': [0x10, 'rel'],
  'JMP': [0x4C, 'abs'], 'JSR': [0x20, 'abs'], 'RTS': [0x60, 'imp'], 'NOP': [0xEA, 'imp'],
};
const SIZE: Record<Mode, number> = { imp: 1, imm: 2, zp: 2, abs: 3, rel: 2 };
type Line = string | [string, (number | string)?];

function assemble(origin: number, src: Line[]): Uint8Array {
  const labels = new Map<string, number>();
  let pc = origin;
  for (const line of src) {
    if (typeof line === 'string') { labels.set(line.replace(/:$/, ''), pc); continue; }
    const op = OPS[line[0]];
    if (!op) throw new Error(`unknown op ${line[0]}`);
    pc += SIZE[op[1]];
  }
  const out: number[] = [];
  pc = origin;
  const value = (v: number | string | undefined): number => {
    if (typeof v === 'number') return v;
    const at = labels.get(v ?? '');
    if (at === undefined) throw new Error(`unknown label ${v}`);
    return at;
  };
  for (const line of src) {
    if (typeof line === 'string') continue;
    const [code, mode] = OPS[line[0]];
    out.push(code);
    if (mode === 'imm' || mode === 'zp') out.push(value(line[1]) & 0xFF);
    else if (mode === 'abs') { const v = value(line[1]); out.push(v & 0xFF, v >> 8); }
    else if (mode === 'rel') {
      const offset = value(line[1]) - (pc + 2);
      if (offset < -128 || offset > 127) throw new Error(`branch to ${line[1]} out of range`);
      out.push(offset & 0xFF);
    }
    pc += SIZE[mode];
  }
  return Uint8Array.from(out);
}

// ── The loader ────────────────────────────────────────────────────────────

const LOADER = 0x6000;
const XLATE = 0x0A00;            // disk byte -> 6-bit value
const TRACKS_LOADED = 3;
// Zero page.
const SECT = 0x41, DEST = 0x42, CURTRK = 0x44, TMP = 0x45, ACC = 0x46, J = 0x47, LO = 0x48;
const TBASE = 0x49, COUNT = 0x4A, ADDR = 0x50, SWAP = 0x60, DONE = 0x70;

const SLOT = 0x60;
const loaderSource: Line[] = [
  ['LDX#', SLOT],
  ['LDA,X', 0xC089],           // motor on
  ['LDA,X', 0xC08A],           // drive 1
  ['LDA,X', 0xC08E],           // read mode
  ['LDA,X', 0xC08C],
  ['LDA,X', 0xC081],           // phase 0 on: hold track 0
  ['LDA#', 0], ['STAz', CURTRK], ['STAz', DEST],
  ['LDA#', 0x10], ['STAz', TBASE],
  'track:',
  ['LDY#', 15], ['LDA#', 0],
  'clr:', ['STA,Y', DONE], ['DEY'], ['BPL', 'clr'],
  ['STAz', COUNT],
  'sector:',
  ['JSR', 'readsector'],
  ['LDAz', COUNT], ['CMP#', 16], ['BNE', 'sector'],
  ['LDAz', CURTRK], ['CMP#', TRACKS_LOADED - 1], ['BEQ', 'done'],
  ['JSR', 'stepin'],
  ['INCz', CURTRK],
  ['LDAz', TBASE], ['CLC'], ['ADC#', 16], ['STAz', TBASE],
  ['JMP', 'track'],
  'done:',
  ['LDA,X', 0xC088],           // motor off
  ['JMP', 0x1001],             // into the first sector, as the boot ROM does

  // One track inward: phase 2t+1 on, 2t off, 2t+2 on, 2t+1 off.
  'stepin:',
  ['LDAz', CURTRK], ['ASL'], ['STAz', TMP],
  ['CLC'], ['ADC#', 1], ['JSR', 'phon'], ['JSR', 'delay'],
  ['LDAz', TMP], ['JSR', 'phoff'], ['JSR', 'delay'],
  ['LDAz', TMP], ['CLC'], ['ADC#', 2], ['JSR', 'phon'], ['JSR', 'delay'],
  ['LDAz', TMP], ['CLC'], ['ADC#', 1], ['JSR', 'phoff'], ['JSR', 'delay'],
  ['RTS'],
  'phon:', ['AND#', 3], ['ASL'], ['ORA#', 1], ['CLC'], ['ADC#', SLOT], ['TAX'],
  ['LDA,X', 0xC080], ['LDX#', SLOT], ['RTS'],
  'phoff:', ['AND#', 3], ['ASL'], ['CLC'], ['ADC#', SLOT], ['TAX'],
  ['LDA,X', 0xC080], ['LDX#', SLOT], ['RTS'],
  'delay:', ['LDY#', 0],
  'dl:', ['DEY'], ['BNE', 'dl'], ['RTS'],

  // Read the next sector of this track not yet loaded; returns either way.
  'readsector:',
  ['LDX#', SLOT],
  'rd1:', ['LDA,X', 0xC08C], ['BPL', 'rd1'],
  'rdd5:', ['CMP#', 0xD5], ['BNE', 'rd1'],
  ['NOP'],                     // let the held byte go before the next read
  'rd2:', ['LDA,X', 0xC08C], ['BPL', 'rd2'],
  ['CMP#', 0xAA], ['BNE', 'rdd5'],
  ['NOP'],
  'rd3:', ['LDA,X', 0xC08C], ['BPL', 'rd3'],
  ['CMP#', 0x96], ['BNE', 'rdd5'],
  ['LDY#', 0],
  'ra:', ['LDA,X', 0xC08C], ['BPL', 'ra'],
  ['STA,Y', ADDR], ['INY'], ['CPY#', 8], ['BNE', 'ra'],
  // Track and sector are 4-and-4: ((a << 1) | 1) & b.
  ['LDAz', ADDR + 2], ['SEC'], ['ROL'], ['ANDz', ADDR + 3], ['CMPz', CURTRK], ['BEQ', 'trkok'],
  ['RTS'],
  'trkok:',
  ['LDAz', ADDR + 4], ['SEC'], ['ROL'], ['ANDz', ADDR + 5], ['STAz', SECT],
  ['TAX'], ['LDAz,X', DONE], ['BEQ', 'fresh'],
  ['RTS'],
  'fresh:',
  ['LDAz', SECT], ['CLC'], ['ADCz', TBASE], ['STAz', DEST + 1],
  ['LDX#', SLOT],
  'dd1:', ['LDA,X', 0xC08C], ['BPL', 'dd1'],
  'ddd5:', ['CMP#', 0xD5], ['BNE', 'dd1'],
  ['NOP'],
  'dd2:', ['LDA,X', 0xC08C], ['BPL', 'dd2'],
  ['CMP#', 0xAA], ['BNE', 'ddd5'],
  ['NOP'],
  'dd3:', ['LDA,X', 0xC08C], ['BPL', 'dd3'],
  ['CMP#', 0xAD], ['BNE', 'ddd5'],
  // 343 nibbles at full speed: 256 to $0B00, 87 to $0C00.
  ['LDY#', 0],
  'db1:', ['LDA,X', 0xC08C], ['BPL', 'db1'],
  ['STA,Y', 0x0B00], ['INY'], ['BNE', 'db1'],
  'db2:', ['LDA,X', 0xC08C], ['BPL', 'db2'],
  ['STA,Y', 0x0C00], ['INY'], ['CPY#', 87], ['BNE', 'db2'],
  // Translate and undo the running XOR in place; it must close at zero.
  ['LDA#', 0], ['STAz', ACC], ['LDY#', 0],
  'x1:', ['LDX,Y', 0x0B00], ['LDA,X', XLATE], ['EORz', ACC], ['STAz', ACC], ['STA,Y', 0x0B00],
  ['INY'], ['BNE', 'x1'],
  'x2:', ['LDX,Y', 0x0C00], ['LDA,X', XLATE], ['EORz', ACC], ['STAz', ACC], ['STA,Y', 0x0C00],
  ['INY'], ['CPY#', 87], ['BNE', 'x2'],
  ['LDAz', ACC], ['BEQ', 'sumok'],
  ['RTS'],
  'sumok:',
  // The 256 six-bit high parts to $0D00 (values 86..341).
  ['LDY#', 0],
  'c1:', ['LDA,Y', 0x0B56], ['STA,Y', 0x0D00], ['INY'], ['CPY#', 170], ['BNE', 'c1'],
  ['LDY#', 0],
  'c2:', ['LDA,Y', 0x0C00], ['STA,Y', 0x0DAA], ['INY'], ['CPY#', 86], ['BNE', 'c2'],
  // Byte i = high << 2 | the two low bits from aux value i % 86, pass i / 86.
  ['LDA#', 0], ['STAz', J], ['LDY#', 0],
  'il:', ['LDXz', J], ['LDA,X', 0x0B00], ['AND#', 3], ['TAX'], ['LDAz,X', SWAP], ['STAz', LO],
  ['LDA,Y', 0x0D00], ['ASL'], ['ASL'], ['ORAz', LO], ['STA(),Y', DEST],
  ['INCz', J], ['LDAz', J], ['CMP#', 86], ['BNE', 'nx'],
  ['LDX#', 85],
  'sh:', ['LSR,X', 0x0B00], ['LSR,X', 0x0B00], ['DEX'], ['BPL', 'sh'],
  ['LDA#', 0], ['STAz', J],
  'nx:', ['INY'], ['BNE', 'il'],
  ['LDXz', SECT], ['LDA#', 1], ['STAz,X', DONE], ['INCz', COUNT],
  ['LDX#', SLOT],
  ['RTS'],
];

/** The program in physical sector 0 of track 0, run at $1001 once loaded. */
const BOOT_PROGRAM = [0xA9, 0xA5, 0x85, 0xF0, 0x4C, 0x05, 0x10];   // LDA #$A5; STA $F0; JMP *

/** A system ROM whose reset vector jumps to the loader: 12K ($D000-$FFFF) for
 *  the ][+, 16K with the //e's internal $C000-$CFFF page first for the //e. */
function makeRom(iie: boolean): Uint8Array {
  const rom = new Uint8Array(iie ? 0x4000 : 0x3000);
  const d000 = iie ? 0x1000 : 0;
  rom.set([0x4C, LOADER & 0xFF, LOADER >> 8], d000);     // $D000: JMP loader
  rom[rom.length - 4] = 0x00;
  rom[rom.length - 3] = 0xD0;
  return rom;
}

/** A 140K DOS-order image: tracks 0-2 hold distinct bytes per sector and the
 *  boot program sits at the start of physical sector 0 of track 0. */
function makeDsk(): Uint8Array {
  const raw = new Uint8Array(35 * 16 * 256);
  let seed = 12345;
  for (let i = 0; i < 3 * 4096; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    raw[i] = seed >>> 24;
  }
  // Physical sector 0 is DOS file sector DOS_SKEW[0] = 0.
  raw.set(BOOT_PROGRAM, DOS_SKEW[0] * 256 + 1);
  return raw;
}

/** Physical sector `r` of track `t` from a DOS-order image. */
function physical(raw: Uint8Array, t: number, r: number): Uint8Array {
  const off = t * 4096 + DOS_SKEW[r] * 256;
  return raw.subarray(off, off + 256);
}

/** Boot `data` (named `name`) running the loader; returns the machine. */
async function boot(
  data: Uint8Array, name: string, model: 'apple2-plus' | 'apple2e-enhanced' = 'apple2-plus',
): Promise<Apple2Machine> {
  const m = new Apple2Machine(model, null);
  m.services.roms.installSystemRom(makeRom(model !== 'apple2-plus'));
  m.memory.ram.set(assemble(LOADER, loaderSource), LOADER);
  m.memory.ram.set(GCR_READ_TABLE, XLATE);
  m.memory.ram.set([0, 2, 1, 3], SWAP);   // the two low bits are stored swapped
  m.memory.ram.fill(0, 0x1000, 0x4000);
  m.memory.ram[0xF0] = 0;
  const res = await m.services.media.mount(data, name, 'a');
  expect(res.ok, res.message).toBe(true);
  for (let frame = 0; frame < 600 && m.memory.ram[0xF0] !== 0xA5; frame++) m.tick();
  return m;
}

function expectLoaded(m: Apple2Machine, raw: Uint8Array): void {
  for (let t = 0; t < TRACKS_LOADED; t++) {
    for (let r = 0; r < 16; r++) {
      const at = 0x1000 + (t * 16 + r) * 256;
      expect(m.memory.ram.subarray(at, at + 256), `track ${t} sector ${r}`).toEqual(physical(raw, t, r));
    }
  }
  expect(m.memory.ram[0xF0], 'boot program ran').toBe(0xA5);
}

// ── Building the other formats ────────────────────────────────────────────

function physicalSectors(raw: Uint8Array, t: number): Uint8Array[] {
  return Array.from({ length: 16 }, (_, r) => physical(raw, t, r).slice());
}

/** A `.nib`: 35 tracks of 6656 plain nibbles (sync bytes stored as `$FF`). */
function makeNib(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(35 * 6656);
  for (let t = 0; t < 35; t++) out.set(encodeTrack(physicalSectors(raw, t), t, 254), t * 6656);
  return out;
}

/**
 * A WOZ 2 file laid out by hand from the reference: header, INFO (60 bytes),
 * TMAP (160), TRKS (160 × 8-byte entries, bits in 512-byte blocks from block
 * 3), CRC-32 of everything after the 12-byte header.
 */
function makeWoz(raw: Uint8Array): Uint8Array {
  const tracks = Array.from({ length: 35 }, (_, t) => encodeTrackBits(physicalSectors(raw, t), t, 254, 16));
  const blocks = tracks.map(t => Math.ceil(t.data.length / 512));
  const size = 1536 + blocks.reduce((a, b) => a + b, 0) * 512;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  out.set([0x57, 0x4F, 0x5A, 0x32, 0xFF, 0x0A, 0x0D, 0x0A]);         // "WOZ2" FF LF CR LF
  out.set([0x49, 0x4E, 0x46, 0x4F], 12); v.setUint32(16, 60, true);   // INFO
  out[20] = 2; out[21] = 1; out[22] = 0; out[23] = 0; out[24] = 1;
  out.fill(0x20, 25, 57); out.set(new TextEncoder().encode('test'), 25);
  out[57] = 1; out[58] = 1; out[59] = 32;                             // sides, 16-sector, 4 µs
  out.set([0x54, 0x4D, 0x41, 0x50], 80); v.setUint32(84, 160, true);  // TMAP
  out.set(standardTmap(35), 88);
  out.set([0x54, 0x52, 0x4B, 0x53], 248); v.setUint32(252, size - 256, true);  // TRKS
  let block = 3;
  tracks.forEach((t, i) => {
    v.setUint16(256 + i * 8, block, true);
    v.setUint16(258 + i * 8, blocks[i], true);
    v.setUint32(260 + i * 8, t.bitCount, true);
    out.set(t.data, block * 512);
    block += blocks[i];
  });
  v.setUint32(8, crc32(out.subarray(12)), true);
  return out;
}

/** A `.2mg` around a ProDOS-order copy of the image (format 1). */
function makeTwoImg(raw: Uint8Array): Uint8Array {
  const body = serializeApple2Disk(parseApple2Disk(raw, 'dos'), 'prodos');
  const out = new Uint8Array(64 + body.length);
  const v = new DataView(out.buffer);
  out.set([0x32, 0x49, 0x4D, 0x47, 0x58, 0x47, 0x53, 0x21]);         // "2IMG" "XGS!"
  v.setUint16(8, 64, true); v.setUint16(10, 1, true);
  v.setUint32(12, 1, true);                                          // ProDOS order
  v.setUint32(20, 280, true);                                        // blocks
  v.setUint32(24, 64, true); v.setUint32(28, body.length, true);
  out.set(body, 64);
  return out;
}

describe('Disk ][ boots through the CPU (own loader)', () => {
  const raw = makeDsk();

  it('loads tracks 0-2 of a .dsk and runs the boot sector', async () => {
    const m = await boot(raw, 'boot.dsk');
    try { expectLoaded(m, raw); } finally { m.destroy(); }
  });

  it('loads the same disk as a ProDOS-order .po', async () => {
    const po = serializeApple2Disk(parseApple2Disk(raw, 'dos'), 'prodos');
    po.set([0x00, 0x00, 0x03, 0x00, 0xF5], 0x400);    // a ProDOS volume header, so .po order is detected
    // Re-derive what physical sector 0 of track 0 holds in the ProDOS reading.
    const m = await boot(po, 'boot.po');
    try {
      const prodos = parseApple2Disk(po, 'prodos');
      for (let r = 0; r < 16; r++) {
        const at = 0x1000 + r * 256;
        expect(m.memory.ram.subarray(at, at + 256), `sector ${r}`).toEqual(prodos.tracks[0][0]!.sectors[r].data);
      }
    } finally { m.destroy(); }
  });

  it('loads the same disk as a .nib (sync bytes widened back to ten cells)', async () => {
    const m = await boot(makeNib(raw), 'boot.nib');
    try { expectLoaded(m, raw); } finally { m.destroy(); }
  });

  it('loads the same disk as a WOZ 2 file', async () => {
    const m = await boot(makeWoz(raw), 'boot.woz');
    try { expectLoaded(m, raw); } finally { m.destroy(); }
  });

  it('loads the WOZ on an Enhanced //e (65C02 access timing)', async () => {
    const m = await boot(makeWoz(raw), 'boot.woz', 'apple2e-enhanced');
    try { expectLoaded(m, raw); } finally { m.destroy(); }
  });

  it('loads the same disk wrapped in a .2mg', async () => {
    const m = await boot(makeTwoImg(raw), 'boot.2mg');
    try { expectLoaded(m, raw); } finally { m.destroy(); }
  });
});
