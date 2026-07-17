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

const SLOT = 0x4000;

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
  for (let i = 0; i < 18; i++) m.crtc.regs[i] = (i * 3 + 5) & 0xFF;
  m.crtc.selectRegister(9);

  // PPI latches.
  m.ppi.setState({ portA: 0xA5, portC: 0x1C, control: 0x82 });

  // PSG: registers 0–13 + a selected register.
  for (let i = 0; i < 14; i++) m.ay.regs[i] = (i * 11 + 3) & 0xFF;
  m.ay.selectedReg = 7;

  // RAM: every bank a different base byte, with embedded RLE edge cases.
  const banks = m.model === 'cpc6128' ? 8 : 4;
  for (let b = 0; b < banks; b++) {
    const bank = m.memory.getRamBank(b);
    bank.fill((b * 37 + 1) & 0xFF);       // long plain run
    bank[0] = 0xE5;                       // single literal marker
    bank[1] = 0x00;
    bank.fill(0xE5, 100, 140);            // run of the marker byte
    bank[SLOT - 1] = (b ^ 0x5A) & 0xFF;
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

  const banks = ref.model === 'cpc6128' ? 8 : 4;
  for (let bk = 0; bk < banks; bk++) {
    expect(loaded.memory.getRamBank(bk), `bank ${bk}`).toEqual(ref.memory.getRamBank(bk));
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

describe('readCpcSnaModel', () => {
  it('reports model + version from the header', () => {
    const v3 = saveCpcSna(new CpcMachine('cpc6128', null), 3);
    expect(readCpcSnaModel(v3)).toEqual({ model: 'cpc6128', version: 3 });

    const v2 = saveCpcSna(new CpcMachine('cpc464', null), 2);
    expect(readCpcSnaModel(v2)).toEqual({ model: 'cpc464', version: 2 });
  });

  it('rejects a file without the MV - SNA signature', () => {
    expect(() => readCpcSnaModel(new Uint8Array(512))).toThrow(/signature/);
  });
});
