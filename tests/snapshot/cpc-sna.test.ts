/**
 * CPC .SNA save/load round-trips.
 *
 * Expectations are derived from the CPCEMU/WinAPE format, not from the encoder:
 * a saved snapshot reloaded into a fresh machine must reproduce the CPU, every
 * RAM bank, the Gate Array, CRTC, PPI and PSG. We assert both header versions
 * (v2 flat, v3 RLE-compressed) and exercise the RLE codec through bytes chosen
 * to stress it (long runs, literal 0xE5, runs of 0xE5).
 */

import { describe, it, expect } from 'vitest';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';
import { saveCpcSna, applyCpcSna, readCpcSnaModel } from '@/machines/cpc/snapshots/cpc-sna.ts';
import type { CpcModel } from '@/models.ts';
import { cpcIsPlusClass } from '@/machines/cpc/models.ts';
import type { Asic } from '@/machines/cpc/asic.ts';

const SLOT = 0x4000;

/** Banks per model — 4 for 464/664, 8 for 6128/6128Plus/GX4000. */
function bankCount(model: CpcModel): number {
  return model === 'cpc464' || model === 'cpc664' ? 4 : 8;
}

/** Fill a machine's state with distinctive, recoverable values. Bank contents
 *  include RLE-hostile patterns (literal 0xE5, runs of 0xE5, long plain runs). */
function seedState(m: CpcMachine): void {
  const cpu = m.cpu;
  cpu.a = 0x12; cpu.f = 0x34; cpu.b = 0x56; cpu.c = 0x78;
  cpu.d = 0x9A; cpu.e = 0xBC; cpu.h = 0xDE; cpu.l = 0xF0;
  cpu.a_ = 0x11; cpu.f_ = 0x22; cpu.b_ = 0x33; cpu.c_ = 0x44;
  cpu.d_ = 0x55; cpu.e_ = 0x66; cpu.h_ = 0x77; cpu.l_ = 0x88;
  cpu.ix = 0xCAFE; cpu.iy = 0xBEEF; cpu.sp = 0xC000; cpu.pc = 0xA742;
  cpu.i = 0x3F; cpu.r = 0x59; cpu.im = 2; cpu.iff1 = true; cpu.iff2 = false;

  // Gate Array: a non-zero pen selected, a full palette, mode 2.
  m.gateArray.write(0x00 | 5);            // select pen 5
  for (let i = 0; i < 17; i++) m.gateArray.pens[i] = (i * 7 + 1) & 0x1F;
  m.gateArray.mode = 2;

  // Paging: expansion banks mapped, lower ROM off, upper ROM = AMSDOS (7).
  m.memory.setRamConfig(2);               // config 2 → banks 4,5,6,7
  m.memory.setLowerRomEnabled(false);
  m.memory.setUpperRomEnabled(true);
  m.memory.selectUpperRom(7);

  // CRTC: distinctive registers + a selected register.
  // Through the chip's write path, so the reference holds only the bits a
  // real 6845 implements (e.g. R9 is 5-bit).
  for (let i = 0; i < 16; i++) { m.crtc.selectRegister(i); m.crtc.writeRegister((i * 3 + 5) & 0xFF); }
  m.crtc.selectRegister(9);

  // PPI latches.
  m.ppi.setState({ portA: 0xA5, portC: 0x1C, control: 0x82 });

  // PSG: registers 0–13 + a selected register.
  for (let i = 0; i < 14; i++) m.ay.regs[i] = (i * 11 + 3) & 0xFF;
  m.ay.selectedReg = 7;

  // RAM: every bank a different base byte, with embedded RLE edge cases.
  const banks = bankCount(m.model);
  for (let b = 0; b < banks; b++) {
    const bank = m.memory.getRamBank(b);
    bank.fill((b * 37 + 1) & 0xFF);       // long plain run
    bank[0] = 0xE5;                       // single literal marker
    bank[1] = 0x00;
    bank.fill(0xE5, 100, 140);            // run of the marker byte
    bank[SLOT - 1] = (b ^ 0x5A) & 0xFF;
  }

  // Plus ASIC: program a distinctive state — unlocked, a non-zero palette
  // entry, sprite pixels, scroll, raster IRQ, and DMA channel 0 mid-pause.
  if (cpcIsPlusClass(m.model)) {
    const asic = m.gateArray as Asic;
    asic.locked = false;
    asic.cpuWrite(0x2400, 0x12);     // pen 0 even byte (R=1, B=2)
    asic.cpuWrite(0x2401, 0x34);     // pen 0 odd byte (G=4)
    asic.cpuWrite(0x0000, 0x07);     // sprite 0 pixel (0,0) = pen 7
    asic.cpuWrite(0x2804, 0x85);     // scroll: extendBorder + vscroll 0 + hscroll 5
    asic.cpuWrite(0x2800, 0x80);     // raster IRQ scanline = 128
    asic.cpuWrite(0x2805, 0xF0);     // interrupt vector = 0xF0
    asic.cpuWrite(0x2C00, 0x10);     // DMA ch0 source lo = 0x10
    asic.cpuWrite(0x2C01, 0x00);     // DMA ch0 source hi = 0x00
    asic.cpuWrite(0x2C0F, 0x01);     // DCSR: enable ch0
    // Dynamic DMA state not stored in registerPage:
    const dma = (asic as unknown as { dma: { pauseTicks: number; loops: number; loopAddr: number }[] }).dma;
    dma[0].pauseTicks = 5;
    dma[0].loops = 3;
    dma[0].loopAddr = 0x1234;
  }
}

/** Assert the loaded machine matches the seeded one in everything .SNA carries. */
function expectMatches(loaded: CpcMachine, ref: CpcMachine): void {
  const a = loaded.cpu, b = ref.cpu;
  for (const k of ['a','f','b','c','d','e','h','l','a_','f_','b_','c_','d_','e_','h_','l_',
                   'ix','iy','sp','pc','i','r','im','iff1','iff2'] as const) {
    expect(a[k], `cpu.${k}`).toBe(b[k]);
  }

  expect(loaded.gateArray.selectedPenIndex).toBe(ref.gateArray.selectedPenIndex);
  expect(loaded.gateArray.mode).toBe(ref.gateArray.mode);
  for (let i = 0; i < 17; i++) {
    expect(loaded.gateArray.pens[i], `pen ${i}`).toBe(ref.gateArray.pens[i]);
  }

  const lp = loaded.memory.pagingState(), rp = ref.memory.pagingState();
  expect(lp.ramConfig).toBe(rp.ramConfig);
  expect(lp.ram64kBlock).toBe(rp.ram64kBlock);
  expect(lp.lowerRomEnabled).toBe(rp.lowerRomEnabled);
  expect(lp.upperRomEnabled).toBe(rp.upperRomEnabled);
  expect(lp.selectedUpperRom).toBe(rp.selectedUpperRom);

  for (let i = 0; i < 18; i++) {
    expect(loaded.crtc.regs[i], `crtc ${i}`).toBe(ref.crtc.regs[i]);
  }
  expect(loaded.crtc.selectedRegister).toBe(ref.crtc.selectedRegister);

  const lpp = loaded.ppi.getState(), rpp = ref.ppi.getState();
  expect(lpp.portA).toBe(rpp.portA);
  expect(lpp.portC).toBe(rpp.portC);
  expect(lpp.control).toBe(rpp.control);

  for (let i = 0; i < 14; i++) {
    expect(loaded.ay.regs[i], `ay ${i}`).toBe(ref.ay.regs[i]);
  }
  expect(loaded.ay.selectedReg).toBe(ref.ay.selectedReg);

  const banks = bankCount(ref.model);
  for (let bk = 0; bk < banks; bk++) {
    expect(loaded.memory.getRamBank(bk), `bank ${bk}`).toEqual(ref.memory.getRamBank(bk));
  }

  // Plus ASIC: the snapshot must restore locked, registerPage (sprites,
  // palette, scroll, raster IRQ, DMA regs), and the dynamic DMA state.
  if (cpcIsPlusClass(ref.model)) {
    const la = loaded.gateArray as Asic, ra = ref.gateArray as Asic;
    expect(la.locked).toBe(ra.locked);
    expect(la.registerPage).toEqual(ra.registerPage);
    expect(la.asicPalette).toEqual(ra.asicPalette);
    expect(la.interruptSl).toBe(ra.interruptSl);
    expect(la.hscroll).toBe(ra.hscroll);
    expect(la.vscroll).toBe(ra.vscroll);
    expect(la.extendBorder).toBe(ra.extendBorder);
    expect(la.interruptVector).toBe(ra.interruptVector);
    const ld = (la as unknown as { dma: { source: number; pauseTicks: number; loops: number; loopAddr: number; enabled: boolean }[] }).dma;
    const rd = (ra as unknown as { dma: { source: number; pauseTicks: number; loops: number; loopAddr: number; enabled: boolean }[] }).dma;
    for (let c = 0; c < 3; c++) {
      expect(ld[c].source, `dma${c}.source`).toBe(rd[c].source);
      expect(ld[c].pauseTicks, `dma${c}.pauseTicks`).toBe(rd[c].pauseTicks);
      expect(ld[c].loops, `dma${c}.loops`).toBe(rd[c].loops);
      expect(ld[c].loopAddr, `dma${c}.loopAddr`).toBe(rd[c].loopAddr);
      expect(ld[c].enabled, `dma${c}.enabled`).toBe(rd[c].enabled);
    }
  }
}

function roundTrip(model: CpcModel, version: 2 | 3): void {
  const ref = new CpcMachine(model, null);
  seedState(ref);
  const data = saveCpcSna(ref, version);

  const loaded = new CpcMachine(model, null);
  applyCpcSna(data, loaded);

  expectMatches(loaded, ref);
}

describe('CPC .SNA round-trip', () => {
  it('restores full 6128 (128K) state from v3 (RLE-compressed)', () => {
    roundTrip('cpc6128', 3);
  });

  it('restores full 6128 (128K) state from v2 (flat)', () => {
    roundTrip('cpc6128', 2);
  });

  it('restores 464 (64K, 4 banks) state from v3', () => {
    roundTrip('cpc464', 3);
  });

  it('restores 664 (64K) state from v2', () => {
    roundTrip('cpc664', 2);
  });

  it('restores 6128Plus (128K + ASIC state) from v3', () => {
    roundTrip('cpc6128plus', 3);
  });

  it('restores GX4000 (128K + ASIC state) from v3', () => {
    roundTrip('gx4000', 3);
  });
});

describe('CPC .SNA Plus upper-ROM select (logical -> physical translation)', () => {
  // .SNA byte 0x55 carries the raw OUT &DFxx value, exactly as selectUpperRom()
  // expects — NOT an already-physical page index. On the Plus, the firmware
  // ROM numbers 0 (BASIC) and 7 (AMSDOS) map to physical cartridge pages 1
  // and 3 respectively; loading byte 0x55 straight into the physical field
  // would misread firmware ROM 7 as physical page 7.
  it('translates a raw firmware ROM number (7 = AMSDOS) to its physical page', () => {
    const ref = new CpcMachine('cpc6128plus', null);
    const data = saveCpcSna(ref, 3);
    data[0x55] = 7;   // raw AMSDOS firmware ROM number, bit 7 clear

    const loaded = new CpcMachine('cpc6128plus', null);
    applyCpcSna(data, loaded);
    expect(loaded.memory.pagingState().selectedUpperRom).toBe(3);
  });

  it('translates a raw firmware ROM number (0 = BASIC) to its physical page', () => {
    const ref = new CpcMachine('cpc6128plus', null);
    const data = saveCpcSna(ref, 3);
    data[0x55] = 0;

    const loaded = new CpcMachine('cpc6128plus', null);
    applyCpcSna(data, loaded);
    expect(loaded.memory.pagingState().selectedUpperRom).toBe(1);
  });

  it('a direct-physical byte (bit 7 set) selects that page unchanged', () => {
    const ref = new CpcMachine('cpc6128plus', null);
    const data = saveCpcSna(ref, 3);
    data[0x55] = 0x80 | 12;

    const loaded = new CpcMachine('cpc6128plus', null);
    applyCpcSna(data, loaded);
    expect(loaded.memory.pagingState().selectedUpperRom).toBe(12);
  });

  it('save encodes the physical page as direct-physical (bit 7 set) so it round-trips', () => {
    const ref = new CpcMachine('cpc6128plus', null);
    ref.memory.setUpperRomEnabled(true);
    ref.memory.selectUpperRom(7); // AMSDOS -> physical page 3
    expect(ref.memory.pagingState().selectedUpperRom).toBe(3);

    const data = saveCpcSna(ref, 3);
    expect(data[0x55]).toBe(0x80 | 3);

    const loaded = new CpcMachine('cpc6128plus', null);
    applyCpcSna(data, loaded);
    expect(loaded.memory.pagingState().selectedUpperRom).toBe(3);
  });

  it('non-Plus models round-trip the raw byte unchanged (no translation)', () => {
    const ref = new CpcMachine('cpc6128', null);
    ref.memory.setUpperRomEnabled(true);
    ref.memory.selectUpperRom(7);
    expect(ref.memory.pagingState().selectedUpperRom).toBe(7);

    const data = saveCpcSna(ref, 3);
    expect(data[0x55]).toBe(7);

    const loaded = new CpcMachine('cpc6128', null);
    applyCpcSna(data, loaded);
    expect(loaded.memory.pagingState().selectedUpperRom).toBe(7);
  });
});

describe('CPC .SNA RLE codec (via the format)', () => {
  it('reproduces a bank with runs, literal 0xE5 and 0xE5 runs byte-for-byte', () => {
    const ref = new CpcMachine('cpc6128', null);
    const bank0 = ref.memory.getRamBank(0);
    // A pattern the encoder must escape and the decoder must rebuild exactly.
    for (let i = 0; i < SLOT; i++) bank0[i] = i % 5 === 0 ? 0xE5 : (i & 0xFF);
    bank0.fill(0xE5, 200, 600);          // long marker run (split across 255)
    bank0.fill(0x42, 1000, 2000);        // long plain run

    const data = saveCpcSna(ref, 3);
    const loaded = new CpcMachine('cpc6128', null);
    applyCpcSna(data, loaded);

    expect(loaded.memory.getRamBank(0)).toEqual(bank0);
  });

  it('v3 with a compressible image is smaller than the flat 256+128K v2', () => {
    const ref = new CpcMachine('cpc6128', null);
    // Mostly-zero RAM compresses heavily under RLE.
    const v2 = saveCpcSna(ref, 2);
    const v3 = saveCpcSna(ref, 3);
    expect(v2.length).toBe(256 + 8 * SLOT);
    expect(v3.length).toBeLessThan(v2.length);
  });
});

/** A hand-built v3 header (no encoder involved): signature, version 3, the
 *  given CPC type byte and memory-dump size in KB. */
function v3Header(typeByte: number, dumpKB: number): Uint8Array {
  const h = new Uint8Array(256);
  h.set([0x4D, 0x56, 0x20, 0x2D, 0x20, 0x53, 0x4E, 0x41], 0);   // "MV - SNA"
  h[0x10] = 3;
  h[0x6B] = dumpKB & 0xFF; h[0x6C] = dumpKB >> 8;
  h[0x6D] = typeByte;
  return h;
}

function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  out[4] = body.length & 0xFF; out[5] = (body.length >> 8) & 0xFF;
  out[6] = (body.length >> 16) & 0xFF; out[7] = (body.length >>> 24) & 0xFF;
  out.set(body, 8);
  return out;
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('CPC .SNA v3 flat memory dump + chunks', () => {
  // cpcwiki SNA format: in v3 the flat dump (size at 0x6B–0x6C, KB) still
  // follows the header; chunks come after the dump. MEMn chunks are only
  // used by writers that set the dump size to 0.
  it('loads a v3 file whose memory is a 128K flat dump', () => {
    const dump = new Uint8Array(128 * 1024);
    for (let b = 0; b < 8; b++) dump.fill(0x10 + b, b * SLOT, (b + 1) * SLOT);
    const data = join([v3Header(2, 128), dump]);
    const m = new CpcMachine('cpc6128', null);
    applyCpcSna(data, m);
    for (let b = 0; b < 8; b++) {
      expect(m.memory.getRamBank(b)[0], `bank ${b} first byte`).toBe(0x10 + b);
      expect(m.memory.getRamBank(b)[SLOT - 1], `bank ${b} last byte`).toBe(0x10 + b);
    }
  });

  it('parses chunks that follow a flat dump (not from offset 0x100)', () => {
    // A 64K dump, then an unknown chunk, then a MEM1 chunk (bank 4-7 data).
    const dump = new Uint8Array(64 * 1024).fill(0x33);
    const mem1 = new Uint8Array(0x10000).fill(0x77);
    const data = join([v3Header(2, 64), dump, chunk('XYZW', new Uint8Array(5)), chunk('MEM1', mem1)]);
    const m = new CpcMachine('cpc6128', null);
    applyCpcSna(data, m);
    expect(m.memory.getRamBank(0)[0]).toBe(0x33);
    expect(m.memory.getRamBank(3)[SLOT - 1]).toBe(0x33);
    expect(m.memory.getRamBank(4)[0]).toBe(0x77);
    expect(m.memory.getRamBank(7)[SLOT - 1]).toBe(0x77);
  });

  it('a MEM1 chunk on a 64K machine does not alias onto base RAM', () => {
    const mem0 = new Uint8Array(0x10000).fill(0x11);
    const mem1 = new Uint8Array(0x10000).fill(0x99);
    const data = join([v3Header(0, 0), chunk('MEM0', mem0), chunk('MEM1', mem1)]);
    const m = new CpcMachine('cpc464', null);
    applyCpcSna(data, m);
    for (let b = 0; b < 4; b++) expect(m.memory.getRamBank(b)[0], `bank ${b}`).toBe(0x11);
  });
});

describe('CPC .SNA v3 Gate Array interrupt state', () => {
  // cpcwiki SNA v3: 0xB2 GA vsync delay counter (HSYNCs since VSYNC start,
  // 0 = inactive), 0xB3 GA interrupt scanline counter (0–51), 0xB4 interrupt
  // request flag.
  it('restores the 52-line counter and a pending interrupt from 0xB3/0xB4', () => {
    const data = join([v3Header(2, 0)]);
    data[0xB3] = 37;
    data[0xB4] = 1;
    const m = new CpcMachine('cpc6128', null);
    applyCpcSna(data, m);
    expect(m.gateArray.rasterCount).toBe(37);
    expect(m.gateArray.interruptRequested).toBe(true);
  });

  it('maps the vsync delay counter to HSYNCs remaining before re-sync', () => {
    const m = new CpcMachine('cpc6128', null);
    const data = v3Header(2, 0);
    data[0xB2] = 1;                       // just started: both HSYNCs to come
    applyCpcSna(data, m);
    expect(m.vsyncResyncCountdown).toBe(2);
    data[0xB2] = 2;
    applyCpcSna(data, m);
    expect(m.vsyncResyncCountdown).toBe(1);
    data[0xB2] = 0;
    applyCpcSna(data, m);
    expect(m.vsyncResyncCountdown).toBe(0);
  });

  it('round-trips the counters through a v3 save', () => {
    const ref = new CpcMachine('cpc6128', null);
    ref.gateArray.rasterCount = 23;
    ref.gateArray.interruptRequested = true;
    ref.vsyncResyncCountdown = 1;
    const data = saveCpcSna(ref, 3);
    expect(data[0xB3]).toBe(23);
    expect(data[0xB4]).toBe(1);
    const m = new CpcMachine('cpc6128', null);
    applyCpcSna(data, m);
    expect(m.gateArray.rasterCount).toBe(23);
    expect(m.gateArray.interruptRequested).toBe(true);
    expect(m.vsyncResyncCountdown).toBe(1);
  });
});

describe('CPC .SNA v3 "CPC+" chunk (Plus ASIC state)', () => {
  function plusChunkBody(): Uint8Array {
    const b = new Uint8Array(0x8F8);
    b[0x000] = 0x73;                 // sprite 0 pixels (0,0)=7, (1,0)=3
    b[0x800] = 0x34; b[0x801] = 0x01; // sprite 0 X = 0x134
    b[0x802] = 0x20; b[0x803] = 0x00; // sprite 0 Y = 0x20
    b[0x804] = 0x05;                 // sprite 0 mag x1/x1
    b[0x880] = 0x12; b[0x881] = 0x04; // pen 0: R=1 B=2, G=4
    b[0x8C0] = 0x80;                 // PRI scanline 128
    b[0x8C1] = 0x10;                 // split line 16
    b[0x8C2] = 0x30; b[0x8C3] = 0x40; // split address &3040
    b[0x8C4] = 0x95;                 // extend border, vscroll 1, hscroll 5
    b[0x8C5] = 0xF1;                 // vector (low 3 bits ignored)
    b[0x8D0] = 0x34; b[0x8D1] = 0x12; // DMA0 address &1234
    b[0x8D2] = 0x02;                 // DMA0 prescaler 2
    b[0x8DF] = 0x01;                 // DMA0 enabled
    b[0x8E0 + 4] = 0x03;             // DMA0 pause count 3
    b[0x8F6] = 1;                    // unlocked
    return b;
  }

  it('restores sprites, palette, scroll/split/PRI and DMA from a CPC+ chunk', () => {
    const data = join([v3Header(4, 0), chunk('MEM0', new Uint8Array(0x10000)),
                       chunk('MEM1', new Uint8Array(0x10000)), chunk('CPC+', plusChunkBody())]);
    const m = new CpcMachine('cpc6128plus', null);
    applyCpcSna(data, m);
    const asic = m.gateArray as Asic;
    expect(asic.locked).toBe(false);
    expect(asic.registerPage[0x0000]).toBe(7);
    expect(asic.registerPage[0x0001]).toBe(3);
    expect(asic.registerPage[0x2000]).toBe(0x34);
    expect(asic.registerPage[0x2001]).toBe(0x01);
    expect(asic.registerPage[0x2004]).toBe(0x05);
    // 4-bit channels scale ×17 into ABGR: R=0x11, G=0x44, B=0x22.
    expect(asic.asicPalette[0] >>> 0).toBe(0xFF224411);
    expect(asic.interruptSl).toBe(128);
    expect(asic.splitSl).toBe(16);
    expect(asic.splitAddr).toBe(0x3040);
    expect(asic.extendBorder).toBe(true);
    expect(asic.vscroll).toBe(1);
    expect(asic.hscroll).toBe(5);
    expect(asic.interruptVector).toBe(0xF0);
    const dma = (asic as unknown as { dma: { source: number; prescaler: number; pauseTicks: number; enabled: boolean }[] }).dma;
    expect(dma[0].source).toBe(0x1234);
    expect(dma[0].prescaler).toBe(2);
    expect(dma[0].enabled).toBe(true);
    expect(dma[0].pauseTicks).toBe(3 * 3);   // pause count × (prescaler + 1)
    expect(dma[1].enabled).toBe(false);
  });

  it('ignores a CPC+ chunk on a non-Plus machine', () => {
    const data = join([v3Header(2, 0), chunk('CPC+', plusChunkBody())]);
    const m = new CpcMachine('cpc6128', null);
    expect(() => applyCpcSna(data, m)).not.toThrow();
  });
});

describe('readCpcSnaModel', () => {
  it('reports model + version from the header', () => {
    const v3 = saveCpcSna(new CpcMachine('cpc6128', null), 3);
    expect(readCpcSnaModel(v3)).toEqual({ model: 'cpc6128', version: 3 });

    const v2 = saveCpcSna(new CpcMachine('cpc464', null), 2);
    expect(readCpcSnaModel(v2)).toEqual({ model: 'cpc464', version: 2 });
  });

  it('uses the published CPC-type byte values (4 = 6128Plus, 6 = GX4000)', () => {
    // cpcwiki SNA File Format, offset 0x6D: 0=464, 1=664, 2=6128, 3=unknown,
    // 4=6128 Plus, 5=464 Plus, 6=GX4000. Getting these wrong made WinAPE
    // 6128 Plus snapshots (type 4) load here as GX4000, and vice versa.
    const plus = saveCpcSna(new CpcMachine('cpc6128plus', null), 3);
    expect(plus[0x6D]).toBe(4);
    expect(readCpcSnaModel(plus)).toEqual({ model: 'cpc6128plus', version: 3 });
    const gx = saveCpcSna(new CpcMachine('gx4000', null), 3);
    expect(gx[0x6D]).toBe(6);
    expect(readCpcSnaModel(gx)).toEqual({ model: 'gx4000', version: 3 });
  });

  it('falls back to 6128 for the unknown (3) and unmodelled 464-Plus (5) type bytes', () => {
    const data = saveCpcSna(new CpcMachine('cpc6128', null), 3);
    data[0x6D] = 3;
    expect(readCpcSnaModel(data).model).toBe('cpc6128');
    data[0x6D] = 5;
    expect(readCpcSnaModel(data).model).toBe('cpc6128');
  });

  it('rejects a file without the MV - SNA signature', () => {
    expect(() => readCpcSnaModel(new Uint8Array(512))).toThrow(/signature/);
  });
});
