/**
 * The 128 as a machine of the app: the registry entry and its descriptor, the
 * ROM sockets, settings and options, the keyboard's extra keys, the joysticks
 * and the Datasette, the debugger's chip dumps, programs and snapshots through
 * media — and, with the real ROMs under mcp/.cache/c128-dev, programs that
 * start the machine in the right mode, and a snapshot that carries on exactly.
 * Expectations are what the hardware does and what BASIC prints.
 */

import { describe, it, expect } from 'vitest';
import { registry, entryForModel } from '@/machines/registry.ts';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import {
  C128_ROM_CHIP_SIZES, C128_ROM_SLOT_LABELS, C128_ROM_SLOT_OFFSETS, C128_ROM_SOURCES, C128_ROM_TOTAL,
} from '@/machines/c128/models.ts';
import { romPageSlotCount, romSlotOffset, romSlotSize, defaultRomPageLabel } from '@/models.ts';
import { C128_SCREEN_WIDTH } from '@/machines/c128/constants.ts';
import { VDC_FRAME_HEIGHT, VDC_FRAME_WIDTH } from '@/machines/c128/vdc-display.ts';
import type { HostKeyEvent, SettingsView } from '@/machines/machine.ts';
import { PRINT_B_PRG } from '../c64/d64-helper.ts';
import { romImage, expectExactFromFile } from '../snapshot/native-state-helpers.ts';

const view = (values: Record<string, unknown>): SettingsView => ({
  get: <T>(key: string, fallback: T): T => (key in values ? values[key] as T : fallback),
});

const key = (code: string, k = ''): HostKeyEvent => ({ code, key: k, shift: false, ctrl: false, alt: false } as unknown as HostKeyEvent);

// ── The registry entry ────────────────────────────────────────────────────────

describe('C128 registry entry and descriptor', () => {
  it('is the one entry for the c128 model', () => {
    expect(entryForModel('c128').kind).toBe('c128');
    expect(registry.filter(e => e.kind === 'c128')).toHaveLength(1);
  });

  it('describes the 40-column VIC-IIe frame, and the 80-column VDC frame when asked', () => {
    const entry = entryForModel('c128');
    const d40 = entry.descriptor('c128');
    expect(d40.cpuFamily).toBe('m6502');
    expect(d40.screen.width).toBe(C128_SCREEN_WIDTH);
    const m = entry.create('c128', null) as C128Machine;
    expect(m.descriptor.screen.width).toBe(d40.screen.width);
    m.setDisplayMode('80');
    expect([m.descriptor.screen.width, m.descriptor.screen.height]).toEqual([VDC_FRAME_WIDTH, VDC_FRAME_HEIGHT]);
    m.destroy();
  });

  it('is NTSC with the US locale and PAL otherwise', () => {
    const entry = entryForModel('c128');
    const pal = entry.create('c128', null) as C128Machine;
    const ntsc = entry.create('c128', null, 'us') as C128Machine;
    expect(pal.timing.ntsc).toBe(false);
    expect(ntsc.timing.ntsc).toBe(true);
    expect(ntsc.timing.linesPerFrame).toBeLessThan(pal.timing.linesPerFrame);
  });

  it('defaults to one 1571 drive and offers the three models', () => {
    const ui = entryForModel('c128').descriptor('c128').ui;
    expect(ui.defaultDriveModels).toEqual(['1571']);
    expect(ui.driveModels?.map(m => m.value)).toEqual(['1541', '1571', '1581']);
    expect(ui.saveMenu).toContain('snapshot-c128state');
  });
});

// ── ROM sockets ───────────────────────────────────────────────────────────────

describe('C128 system ROM sockets', () => {
  it('has six sockets of two sizes, each at the sum of the chips before it', () => {
    expect(C128_ROM_CHIP_SIZES).toEqual([0x4000, 0x4000, 0x4000, 0x2000, 0x2000, 0x2000]);
    expect([...C128_ROM_SLOT_OFFSETS]).toEqual([0, 0x4000, 0x8000, 0xC000, 0xE000, 0x10000]);
    expect(C128_ROM_TOTAL).toBe(0x12000);
    expect(C128_ROM_SOURCES).toHaveLength(6);
    expect(romPageSlotCount('c128')).toBe(6);
    expect(C128_ROM_SLOT_LABELS).toHaveLength(6);
    expect(defaultRomPageLabel('c128', 3)).toBe('Character ROM');
  });

  it('is asked a socket\'s own size and offset by the shell', () => {
    expect([0, 1, 2, 3, 4, 5].map(p => romSlotSize('c128', p))).toEqual([...C128_ROM_CHIP_SIZES]);
    expect([0, 1, 2, 3, 4, 5].map(p => romSlotOffset('c128', p))).toEqual([...C128_ROM_SLOT_OFFSETS]);
    // The other machines keep their stride.
    expect(romSlotOffset('c64', 2)).toBe(2 * romSlotSize('c64'));
  });

  it('splits the six images end to end into the right chips', () => {
    const image = new Uint8Array(C128_ROM_TOTAL);
    C128_ROM_CHIP_SIZES.forEach((size, i) => image.fill(0x10 + i, C128_ROM_SLOT_OFFSETS[i], C128_ROM_SLOT_OFFSETS[i] + size));
    const m = new C128Machine(null);
    m.services.roms.installSystemRom(image);
    const mem = m.memory;
    expect([mem.basicLo[0], mem.basicHi[0], mem.kernal[0], mem.chargen[0], mem.basic64[0], mem.kernal64[0]])
      .toEqual([0x10, 0x11, 0x12, 0x13, 0x14, 0x15]);
    expect(mem.kernal[0x3FFF]).toBe(0x12);
    expect(mem.chargen[0x1FFF]).toBe(0x13);
    expect(mem.kernal64[0x1FFF]).toBe(0x15);
  });

  it('reports a socket for each chip, and one per DOS ROM of the drives fitted', () => {
    const m = new C128Machine(null);
    expect(m.services.roms.systemSlots.map(s => s.title)).toEqual([...C128_ROM_SLOT_LABELS]);
    m.fitDrives(['1571', '1581']);
    expect(m.services.roms.sidewaysSlots?.length).toBe(2);
    expect(m.services.roms.cartridge).toBeNull();
  });

  it('is recognised as a whole ROM by its size alone', () => {
    const entry = entryForModel('c128');
    expect(entry.detectModelForRom?.(new Uint8Array(C128_ROM_TOTAL), 'zx48k')).toBe('c128');
    expect(entry.detectModelForRom?.(new Uint8Array(0x4000), 'zx48k')).toBeNull();
  });
});

// ── Settings and options ──────────────────────────────────────────────────────

describe('C128 settings', () => {
  it('sizes the VDC RAM and fits the drives before the machine starts', () => {
    const m = new C128Machine(null);
    expect(m.vdc.ram.length).toBe(0x4000);
    const requests = m.prepare(view({ 'c128-vdc-ram': '64k', 'drive-models:c128': ['1571', '1541'] }));
    expect(m.vdc.ram.length).toBe(0x10000);
    expect(m.drives.map(d => d.model)).toEqual(['1571', '1541']);
    expect(requests.map(r => r.failId).sort()).toEqual(['c64-dos1541', 'c64-dos1571']);
  });

  it('fits one 1571 by default and takes the bus empty when the drive is unplugged', () => {
    const m = new C128Machine(null);
    m.prepare(view({}));
    expect(m.drives.map(d => d.model)).toEqual(['1571']);
    const none = new C128Machine(null);
    expect(none.prepare(view({ 'c128-drive': false }))).toEqual([]);
    expect(none.drives).toHaveLength(0);
  });

  it('applies the SID model, the tape turbo and the Display choice', () => {
    const m = new C128Machine(null);
    m.applySettings(view({ 'c64-sid': '8580', 'tape-turbo-load': false, 'c128-display': '80' }));
    expect(m.sid.model).toBe('8580');
    expect(m.tapeTurbo).toBe(false);
    expect(m.showing80).toBe(true);
    m.applySettings(view({}));
    expect(m.showing80).toBe(false);
  });

  it('keeps the VDC RAM of a snapshot: one saved with 16K is refused by a machine with 64K', async () => {
    const small = new C128Machine(null);
    small.reset();
    const file = await small.services.snapshots.save('.c128state');
    const big = new C128Machine(null);
    big.prepare(view({ 'c128-vdc-ram': '64k' }));
    big.reset();
    const r = await big.services.snapshots.apply(file, 'x.c128state');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/16K of VDC RAM/);
  });
});

// ── The keyboard's extra keys ─────────────────────────────────────────────────

describe('C128 host keys', () => {
  it('presses the 128\'s own keys from F9, F10, right Alt and Scroll Lock, and releases them', () => {
    const m = new C128Machine(null);
    const input = m.services.input;
    for (const [code, name] of [['F9', 'esc'], ['F10', 'help'], ['AltRight', 'alt'], ['ScrollLock', 'no-scroll']] as const) {
      expect(input.keyDown(key(code))).toBe(true);
      expect(m.keyboard.isPressed(name), `${code} presses ${name}`).toBe(true);
      expect(input.keyUp(key(code))).toBe(true);
      expect(m.keyboard.isPressed(name), `${code} releases ${name}`).toBe(false);
    }
  });

  it('latches CAPS LOCK onto the 8502 port bit 6 and the 40/80 key onto the mode register', () => {
    const m = new C128Machine(null);
    m.reset();
    expect(m.memory.portPins & 0x40).toBe(0x40);
    m.services.input.keyDown(key('CapsLock'));
    m.services.input.keyUp(key('CapsLock'));
    expect(m.keyboard.capsLock).toBe(true);
    expect(m.memory.portPins & 0x40, 'bit 6 reads low while CAPS LOCK is down').toBe(0);
    m.services.input.keyDown(key('CapsLock'));
    expect(m.memory.portPins & 0x40).toBe(0x40);

    expect(m.memory.mmu.read(5) & 0x80, 'the 40/80 key reads high while up').toBe(0x80);
    m.services.input.keyDown(key('Pause'));
    expect(m.showing80).toBe(true);
    expect(m.memory.mmu.read(5) & 0x80, 'and low while down').toBe(0);
  });

  it('still types by character: a keypad digit is the main row\'s digit', () => {
    const m = new C128Machine(null);
    m.services.input.keyDown(key('Numpad5', '5'));
    expect(m.keyboard.isPressed('5')).toBe(true);
  });
});

// ── Joysticks and the mouse ───────────────────────────────────────────────────

describe('C128 control ports', () => {
  it('reads a stick in port 2 on CIA 1 port A and one in port 1 on port B, low when held', () => {
    const m = new C128Machine(null);
    m.reset();
    m.services.input.joystick!.press('fire', true, 'c128-port2', 0);
    expect(m.cia1.portAIn!(0xFF) & 0x10).toBe(0);
    m.services.input.joystick!.press('up', true, 'c128-port1', 1);
    expect(m.cia1.portBIn!(0xFF) & 0x01).toBe(0);
    m.services.input.releaseAll();
    expect(m.cia1.portAIn!(0xFF) & 0x1F).toBe(0x1F);
    expect(m.cia1.portBIn!(0xFF) & 0x1F).toBe(0x1F);
  });

  it('plugs a 1351 into a port: its buttons read as fire and up there, its position through the SID', () => {
    const m = new C128Machine(null);
    m.reset();
    const mice = m.services.input.mice!;
    mice.setMode('c128-1351-port1');
    mice.button(0, true, 'c128-1351-port1');
    expect(m.cia1.portBIn!(0xFF) & 0x10, 'left button is fire').toBe(0);
    mice.button(0, false, 'c128-1351-port1');
    m.cia1.write(2, 0xFF);                              // port A all outputs
    m.cia1.write(0, 0x40);                              // bit 6 high selects port 1's paddles
    mice.motion(5, 0, 'c128-1351-port1');
    expect(m.sid.potRead!(0)).toBe(5 << 1);
    mice.setMode('none');
    expect(m.sid.potRead!(0)).toBe(0xFF);
  });
});

// ── The Datasette ─────────────────────────────────────────────────────────────

describe('C128 Datasette', () => {
  it('stands for a blank cassette with the buttons down when nothing is mounted', () => {
    const m = new C128Machine(null);
    m.reset();
    expect(m.memory.cassetteSense, 'PLAY reads down on an empty deck, so SAVE goes to the recorder').toBe(true);
  });

  it('keeps PLAY up on a mounted tape, and follows the 8502 port\'s motor line', () => {
    const m = new C128Machine(null);
    m.reset();
    expect(m.services.tape.mount(PRINT_B_PRG, 'b.prg')).toBe(true);
    m.tapeTransportChanged();
    expect(m.tape.loaded).toBe(true);
    expect(m.memory.cassetteSense, 'PLAY up').toBe(false);
    expect(m.memory.portPins & 0x10, 'the sense bit reads high').toBe(0x10);
    m.memory.writeByte(0x00, 0x2F);                    // bits 0-3 and 5 out
    m.memory.writeByte(0x01, 0x00);                    // motor line low: on
    expect(m.memory.motorOn).toBe(true);
    m.memory.writeByte(0x01, 0x20);
    expect(m.memory.motorOn).toBe(false);
  });
});

// ── Chip dumps and the memory map ─────────────────────────────────────────────

describe('C128 debugger views', () => {
  it('dumps every chip without touching the bus', () => {
    const m = new C128Machine(null);
    m.reset();
    const names = m.chips().map(c => c.name);
    expect(names).toEqual(expect.arrayContaining(['vic', 'vdc', 'sid', 'cia1', 'cia2', 'mmu']));
    for (const chip of m.chips()) {
      const text = chip.dump();
      expect(typeof text, chip.name).toBe('string');
      expect(text.length, chip.name).toBeGreaterThan(0);
    }
    const mmu = m.chips().find(c => c.name === 'mmu')!.dump();
    expect(mmu).toMatch(/CPU\s+Z80\s+mode C128/);
    const vdc = m.chips().find(c => c.name === 'vdc')!.dump();
    expect(vdc).toMatch(/RAM 16K/);
  });

  it('reports the memory map for either mode', () => {
    const m = new C128Machine(null);
    m.reset();
    const map = m.services.probe.panes!.memoryMap!()!;
    expect(map.slots.map(s => s.range)).toContain('C000-FFFF');
    expect(map.registers.find(r => r.name === 'Mode')!.value).toContain('C128');
  });

  it('exposes the ROMs, colour RAM and VDC RAM to the Memory pane', () => {
    const m = new C128Machine(null);
    for (const r of ['rom-basic-lo', 'rom-basic-hi', 'rom-system', 'rom-chargen', 'rom-basic64', 'rom-kernal64', 'color-ram', 'vdc-ram']) {
      expect(m.resolveMemoryRegion(r), r).not.toBeNull();
    }
    expect(m.resolveMemoryRegion('nonsense')).toBeNull();
    expect(m.ramExportBytes().data.length).toBe(0x20000);
  });
});

// ── With the real ROMs ────────────────────────────────────────────────────────

const REAL = 'c128-dev/';
const basicLo = romImage(REAL + 'basiclo');
const basicHi = romImage(REAL + 'basichi');
const kernal = romImage(REAL + 'kernal');
const chargen = romImage(REAL + 'chargen');
const basic64 = romImage(REAL + 'basic64');
const kernal64 = romImage(REAL + 'kernal64');
const haveBoard = !!(basicLo && basicHi && kernal && chargen && basic64 && kernal64);

function booted(frames = 220): C128Machine {
  const m = new C128Machine(null);
  m.loadRoms(basicLo, basicHi, kernal, chargen, basic64, kernal64);
  m.reset();
  for (let f = 0; f < frames; f++) m.tick();
  return m;
}

function chord(ch: string): { key: string; shift?: boolean } {
  switch (ch) {
    case ' ': return { key: 'space' };
    case '\n': return { key: 'return' };
    case '"': return { key: '2', shift: true };
    default: return { key: ch.toLowerCase() };
  }
}

function type(m: C128Machine, text: string): void {
  for (const ch of text) {
    const { key: k, shift } = chord(ch);
    if (shift) m.keyboard.setKey('lshift', true);
    m.keyboard.setKey(k, true);
    for (let f = 0; f < 4; f++) m.tick();
    m.keyboard.setKey(k, false);
    if (shift) m.keyboard.setKey('lshift', false);
    for (let f = 0; f < (ch === '\n' ? 9 : 3); f++) m.tick();
  }
}

/** `10 PRINT "HI"` as BASIC 7.0 stores it (program text at $1C01). */
const PRINT_HI_PRG7 = Uint8Array.from([
  0x01, 0x1C, 0x0C, 0x1C, 0x0A, 0x00, 0x99, 0x20, 0x22, 0x48, 0x49, 0x22, 0x00, 0x00, 0x00,
]);

describe.skipIf(!haveBoard)('C128 programs and snapshots with the real ROMs', { timeout: 60_000 }, () => {
  it('runs a BASIC 7.0 program (start $1C01) in C128 mode', async () => {
    const m = booted();
    const r = await m.services.media.mount(PRINT_HI_PRG7, 'hi.prg');
    expect(r.ok, r.message).toBe(true);
    for (let f = 0; f < 420; f++) m.tick();
    expect(m.c64Mode).toBe(false);
    expect(m.ocrScreenForMcp()).toMatch(/\nHI\s*\n/);
  });

  it('starts a 64\'s BASIC program (start $0801) in C64 mode, as C= held at power-on does, and runs it', async () => {
    const m = booted();
    expect(m.c64Mode).toBe(false);
    const r = await m.services.media.mount(PRINT_B_PRG, 'b.prg');
    expect(r.ok, r.message).toBe(true);
    for (let f = 0; f < 420; f++) m.tick();
    expect(m.c64Mode, 'the machine restarted in C64 mode').toBe(true);
    expect(m.keyboard.isPressed('cbm'), 'C= was let go again').toBe(false);
    expect(m.ocrScreenForMcp()).toMatch(/\nB\s*\n/);
  });

  it('types a program and keeps the keyboard\'s extra keys out of the 64\'s matrix', () => {
    const m = booted();
    type(m, 'PRINT 6*7\n');
    expect(m.ocrScreenForMcp()).toContain('42');
  });

  it('loads a program from the Datasette: PLAY goes down by itself, FOUND, LOADING, then RUN', () => {
    const m = booted();
    expect(m.services.tape.mount(PRINT_B_PRG, 'b.prg')).toBe(true);
    m.tapeTransportChanged();
    m.armAutoPlay();
    type(m, 'LOAD "B"\n');
    for (let f = 0; f < 2500; f++) m.tick();
    const text = m.ocrScreenForMcp();
    expect(text).toContain('PRESS PLAY ON TAPE');
    expect(text).toMatch(/FOUND B/);
    expect(text).toMatch(/READY\./);
    type(m, 'RUN\n');
    expect(m.ocrScreenForMcp()).toMatch(/\nB\s*\n/);
  });

  it('saves to the empty deck: the write line\'s edges are recorded', () => {
    const m = booted();
    type(m, '10 PRINT 1\n');
    type(m, 'SAVE "S"\n');
    for (let f = 0; f < 1500; f++) m.tick();
    expect(m.tapeRecorder.count, 'the KERNAL wrote pulses to the cassette port').toBeGreaterThan(1000);
  });

  it('takes the machine to a state file and back, exactly: a restored machine runs on as the original does', async () => {
    const m = booted();
    type(m, 'A=7\n');
    for (let f = 0; f < 5; f++) m.tick();
    const fresh = new C128Machine(null);
    fresh.loadRoms(basicLo, basicHi, kernal, chargen, basic64, kernal64);
    await expectExactFromFile(m, fresh, '.c128state', 6);
    type(fresh, 'PRINT A\n');
    expect(fresh.ocrScreenForMcp()).toMatch(/\n\s*7\s*\n/);
    m.destroy();
    fresh.destroy();
  });

  it('keeps the C64 mode and the 80-column display in a state file', async () => {
    const m = booted();
    m.setDisplay80(true);
    for (let f = 0; f < 3; f++) m.tick();
    const file = await m.services.snapshots.save('.c128state');
    const fresh = new C128Machine(null);
    fresh.loadRoms(basicLo, basicHi, kernal, chargen, basic64, kernal64);
    const r = await fresh.services.snapshots.apply(file, 'x.c128state');
    expect(r.ok, r.message).toBe(true);
    expect(fresh.showing80).toBe(true);
    expect(fresh.vdc.regs[1], 'the VDC came with it').toBe(m.vdc.regs[1]);
    expect(fresh.cpuIs8502).toBe(true);
  });
});
