/**
 * Sony HB-55 (Japanese MSX1, NTSC).
 *
 * Expectations come from the hardware, not the implementation:
 *  - MAME msx1.cpp `hb55` / openMSX Sony_HB-55P.xml / MSX Wiki: slot 0 holds the
 *    32KB BIOS+BASIC (pages 0-1), an 8KB Personal Data Bank ROM at 0x8000 and
 *    just 16KB of RAM at 0xC000; slot 1 is the cartridge slot; no sub-slots.
 *  - NTSC video is 262 lines of 228 CPU clocks = 59 736 T-states per field.
 *  - Kana-lock LED is PSG register 15 bit 7 (active-low); the かな key is the
 *    CODE key (matrix row 6 bit 4).
 *
 * The boot tests use the HX-10 BIOS as a stand-in (any MSX1 BIOS probes the slots
 * for RAM), so they are skipped without it; no HB-55 BIOS image is needed to prove
 * the slot layout, timing and cartridge/cassette paths.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MsxMachine } from '@/machines/msx/msx-machine.ts';
import { MsxMemory } from '@/machines/msx/msx-memory.ts';
import { createMsxConfig } from '@/machines/msx/config.ts';
import { isMsxModel } from '@/machines/msx/models.ts';
import { entryForModel } from '@/machines/registry.ts';
import type { SettingsView } from '@/machines/machine.ts';

const BIOS = process.env.MSX_BIOS ?? join(import.meta.dirname, '../../mcp/.cache/hx-10_basic-bios1.rom');
const haveBios = existsSync(BIOS);

const view: SettingsView = { get: (_key: string, def: unknown) => def } as SettingsView;

function hb55Memory(): MsxMemory {
  return new MsxMemory(createMsxConfig('hb-55').layout);
}

describe('HB-55 model registration', () => {
  it('is an MSX model with its own hosted BIOS name', () => {
    expect(isMsxModel('hb-55')).toBe(true);
    expect(entryForModel('hb-55').kind).toBe('msx');
    expect(entryForModel('hb-55').romSources('hb-55')).toEqual(['msx/hb-55_basic-bios1.rom']);
    expect(entryForModel('hx-10').romSources('hx-10')).toEqual(['msx/hx-10_basic-bios1.rom']);
  });

  it('asks for the 8KB Data Bank ROM as an optional aux ROM, only on the HB-55', () => {
    const hb = new MsxMachine('hb-55');
    const hx = new MsxMachine('hx-10');
    try {
      const req = hb.prepare(view);
      expect(req.map(r => r.source)).toEqual(['msx/hb-55_firmware.rom']);
      expect(hx.prepare(view)).toEqual([]);
      hb.loadFirmware(new Uint8Array(0x2000));
      expect(hb.prepare(view)).toEqual([]);   // not requested again once loaded
    } finally { hb.destroy(); hx.destroy(); }
  });
});

describe('HB-55 slot layout (no sub-slots)', () => {
  function rom(): Uint8Array {
    const r = new Uint8Array(0x8000);
    r[0] = 0x42; r[0x7FFF] = 0x11;
    return r;
  }

  it('maps the 16KB RAM into slot 0 page 3 and leaves page 2 empty without firmware', () => {
    const mem = hb55Memory();
    mem.loadROM(rom());
    mem.reset();
    expect(mem.readByte(0x0000)).toBe(0x42);
    expect(mem.readByte(0x7FFF)).toBe(0x11);
    expect(mem.readByte(0x8000)).toBe(0xFF);          // no firmware: empty
    mem.writeByte(0xC000, 0x5A);
    mem.writeByte(0xFFFF, 0xA5);                      // top of RAM: plain RAM, no expansion register
    expect(mem.readByte(0xC000)).toBe(0x5A);
    expect(mem.readByte(0xFFFF)).toBe(0xA5);
    mem.writeByte(0x8000, 0x77);                      // nothing there to write
    expect(mem.readByte(0x8000)).toBe(0xFF);
  });

  it('puts the 8KB Data Bank ROM at 0x8000-0x9FFF (read-only), 0xA000-0xBFFF empty', () => {
    const mem = hb55Memory();
    const fw = new Uint8Array(0x2000);
    fw[0] = 0x41; fw[1] = 0x42; fw[0x1FFF] = 0xE7;
    mem.loadFirmware(fw);
    expect(mem.readByte(0x8000)).toBe(0x41);
    expect(mem.readByte(0x9FFF)).toBe(0xE7);
    expect(mem.readByte(0xA000)).toBe(0xFF);
    expect(mem.readByte(0xBFFF)).toBe(0xFF);
    mem.writeByte(0x8000, 0x00);
    expect(mem.readByte(0x8000)).toBe(0x41);
  });

  it('has no RAM in slot 2 and none below 0xC000', () => {
    const mem = hb55Memory();
    mem.setPrimarySlots(0xAA);                        // every page -> slot 2
    for (const a of [0x0000, 0x4000, 0x8000, 0xC000, 0xFFFF]) {
      mem.writeByte(a, 0x12);
      expect(mem.readByte(a)).toBe(0xFF);
    }
  });

  it('reports one 16KB RAM bank and places the snapshot at its CPU address', () => {
    const mem = hb55Memory();
    mem.writeByte(0xC123, 0x99);
    expect(mem.ramBankCount).toBe(1);
    expect(mem.getRamBank(0)[0x0123]).toBe(0x99);
    expect(mem.getRamBank(5)[0x0123]).toBe(0x99);     // out-of-range wraps onto the only bank
    const snap = mem.ramSnapshot();
    expect(snap.length).toBe(0x10000);
    expect(snap[0xC123]).toBe(0x99);
    expect(snap[0x0123]).toBe(0);
    expect(mem.ramBytes().length).toBe(0x4000);
  });

  it('leaves the HX-10 layout alone (64KB in slot 2, nothing in slot 0 page 3)', () => {
    const mem = new MsxMemory();
    expect(mem.ramBankCount).toBe(4);
    mem.setPrimarySlots(0xFF);
    expect(mem.readByte(0xC000)).toBe(0xFF);          // slot 3, empty
    mem.setPrimarySlots(0x00);
    mem.writeByte(0xC000, 0x12);
    expect(mem.readByte(0xC000)).toBe(0xFF);          // slot 0 page 3 empty on the HX-10
    mem.loadFirmware(new Uint8Array(0x2000).fill(1)); // no firmware page: ignored
    expect(mem.hasFirmware).toBe(false);
  });
});

describe('NTSC / PAL field timing', () => {
  it('runs 262 lines x 228 clocks per HB-55 field and the HX-10 frame unchanged', () => {
    const hb = new MsxMachine('hb-55');
    const hx = new MsxMachine('hx-10');
    try {
      expect(hb.config.linesPerFrame).toBe(262);
      expect(hb.tStatesPerFrame).toBe(59736);
      expect(hx.config.linesPerFrame).toBe(313);
      expect(hx.tStatesPerFrame).toBe(71591);
      // A real field's worth of CPU time elapses per tick (within one instruction).
      for (const m of [hb, hx]) {
        m.reset();
        m.tick();
        const t0 = m.cpu.tStates;
        m.tick();
        expect(Math.abs(m.cpu.tStates - t0 - m.tStatesPerFrame)).toBeLessThan(40);
      }
      // 3.579545 MHz / 59736 = 59.92 Hz: the pacing clock follows the model.
      expect((hb as unknown as { frameHz: number }).frameHz).toBe(60);
      expect((hx as unknown as { frameHz: number }).frameHz).toBe(50);
    } finally { hb.destroy(); hx.destroy(); }
  });

  it('raises the vblank interrupt once per field', () => {
    const m = new MsxMachine('hb-55');
    try {
      m.reset();
      m.vdp.writeControl(0x60); m.vdp.writeControl(0x81);   // R1 = 0x60: display + IE
      let raised = 0;
      for (let f = 0; f < 5; f++) {
        m.tick();
        if (m.vdp.interruptPending()) raised++;
        m.vdp.readStatus();                                  // acknowledge
      }
      expect(raised).toBe(5);
    } finally { m.destroy(); }
  });
});

describe('Japanese keyboard', () => {
  it('maps the かな key (KanaMode) to the CODE key in the standard matrix', () => {
    const m = new MsxMachine('hb-55');
    try {
      expect(m.keyboard.handleKeyEvent('KanaMode', true)).toBe(true);
      expect(m.keyboard.rows[6]).toBe(0xFF & ~0x10);
      m.keyboard.handleKeyEvent('KanaMode', false);
      expect(m.keyboard.rows[6]).toBe(0xFF);
    } finally { m.destroy(); }
  });

  it('drives the kana LED from PSG register 15 bit 7 (active-low)', () => {
    const m = new MsxMachine('hb-55');
    try {
      const out = (port: number, v: number) => m.cpu.portOut(port, v);
      expect(m.kanaLed).toBe(false);
      out(0xA0, 15); out(0xA1, 0x7F);        // bit 7 low -> lit
      expect(m.kanaLed).toBe(true);
      out(0xA1, 0xFF);
      expect(m.kanaLed).toBe(false);
      out(0xA1, 0x7F);
      m.reset();
      expect(m.kanaLed).toBe(false);
    } finally { m.destroy(); }
  });
});

/** Press a character on the emulated keyboard. */
function press(m: MsxMachine, ch: string): void {
  const shift = ch === '+';
  const map: Record<string, string> = { ' ': 'Space', '+': 'Equal', '\n': 'Enter' };
  const code = map[ch] ?? (/[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : `Digit${ch}`);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', true);
  m.keyboard.handleKeyEvent(code, true);
  for (let i = 0; i < 4; i++) m.tick();
  m.keyboard.handleKeyEvent(code, false);
  if (shift) m.keyboard.handleKeyEvent('ShiftLeft', false);
  for (let i = 0; i < 4; i++) m.tick();
}

describe.skipIf(!haveBios)('HB-55 machine layout against a real MSX1 BIOS', () => {
  function boot(): MsxMachine {
    const m = new MsxMachine('hb-55');
    m.loadROM(new Uint8Array(readFileSync(BIOS)));
    m.turbo = true;
    m.reset();
    for (let i = 0; i < 1000; i++) m.tick();
    return m;
  }

  it('boots to the MSX BASIC prompt with only 16KB of RAM, and PRINT 2+2 works', () => {
    const m = boot();
    try {
      const screen = m.ocrScreenForMcp();
      expect(screen).toContain('MSX BASIC');
      expect(screen).toContain('Ok');
      const free = /(\d+) Bytes free/.exec(screen);
      expect(free).not.toBeNull();
      // 16KB machine: well under 16384, and far below the HX-10's ~28K.
      expect(Number(free![1])).toBeGreaterThan(8000);
      expect(Number(free![1])).toBeLessThan(16384);

      for (const ch of 'print 2+2\n') press(m, ch);
      for (let i = 0; i < 30; i++) m.tick();
      expect(m.ocrScreenForMcp().split('\n').some(l => l.trim() === '4')).toBe(true);
    } finally { m.destroy(); }
  });

  it('still boots the HX-10 with its 64KB of RAM', () => {
    const m = new MsxMachine('hx-10');
    try {
      m.loadROM(new Uint8Array(readFileSync(BIOS)));
      m.turbo = true;
      m.reset();
      for (let i = 0; i < 1000; i++) m.tick();
      const free = /(\d+) Bytes free/.exec(m.ocrScreenForMcp());
      expect(free).not.toBeNull();
      expect(Number(free![1])).toBeGreaterThan(20000);
    } finally { m.destroy(); }
  });

  it('runs a slot-1 cartridge INIT during the BIOS slot scan', () => {
    const m = new MsxMachine('hb-55');
    try {
      // "AB" header, INIT = 0x4010: LD A,5Ah ; LD (E000h),A ; RET
      const cart = new Uint8Array(0x4000).fill(0xFF);
      cart.set([0x41, 0x42, 0x10, 0x40, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      cart.set([0x3E, 0x5A, 0x32, 0x00, 0xE0, 0xC9], 0x10);
      m.loadROM(new Uint8Array(readFileSync(BIOS)));
      m.insertCartridge(cart, 'init-test.rom');
      m.turbo = true;
      m.reset();
      for (let i = 0; i < 1000; i++) m.tick();
      expect(m.memory.ramSnapshot()[0xE000]).toBe(0x5A);
      expect(m.ocrScreenForMcp()).toContain('Ok');   // BASIC still reached
    } finally { m.destroy(); }
  });
});

describe('HB-55 cassette traps', () => {
  const ID = [0x1F, 0xA6, 0xDE, 0xBA, 0xCC, 0x13, 0x7D, 0x74];

  it('records TAPOON/TAPOUT output with RAM in slot 0 page 3', () => {
    const rom = new Uint8Array(0x8000);
    rom.set([
      0xF3,                         // DI
      0x31, 0x00, 0xF0,             // LD SP,F000h (RAM is already mapped at C000)
      0xAF, 0xCD, 0xEA, 0x00,       // XOR A ; CALL TAPOON
      0x3E, 0xD3, 0xCD, 0xED, 0x00, // LD A,D3h ; CALL TAPOUT
      0x3E, 0x42, 0xCD, 0xED, 0x00, // LD A,42h ; CALL TAPOUT
      0x76,                         // HALT
    ]);
    rom[0xEA] = 0xC9; rom[0xED] = 0xC9;
    const m = new MsxMachine('hb-55');
    try {
      m.loadROM(rom);
      m.reset();
      m.tick();
      expect(Array.from(m.cassette.recorded() ?? [])).toEqual([...ID, 0xD3, 0x42]);
    } finally { m.destroy(); }
  });
});
