/**
 * Acorn Atom integration tests: registration, the 12 KB memory map, the PPI and
 * keyboard wiring, OCR mapping, native snapshots, and — when the Acorn ROMs are
 * in the MCP cache — a real boot to BASIC and a typed PRINT.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AtomMachine } from '@/machines/atom/atom-machine.ts';
import { atomEntry } from '@/machines/atom/descriptor.ts';
import { AtomKeyboard } from '@/machines/atom/atom-keyboard.ts';
import { ATOM_TAPE_EXTENSIONS, parseAtomTape } from '@/machines/atom/atom-tape.ts';
import { DECK_KEYS } from '@/ui/keyboard/deck-layout.ts';
import { DECK_SCENE, DECK_BADGE_BOX, placeDeckKeys } from '@/ui/keyboard/deck-geometry.ts';
import { buildUef, type UefChunk } from '@/media/tape/uef.ts';
import { TAPE_REF_HZ, type CswBlock } from '@/media/tape/tap.ts';
import { machineUi } from '@/ui/machine-ui.ts';
import { parseAtomRam } from '@/machines/atom/options.ts';
import { atomCodeToAscii, atomCodeIsInverse, ocrAtomText } from '@/ocr/atom.ts';
import { registry } from '@/machines/registry.ts';
import { createFrameIndicators, type HostKeyEvent } from '@/machines/machine.ts';
import {
  ATOM_ACTIVE_HEIGHT, ATOM_ACTIVE_WIDTH, ATOM_BORDER_LEFT, ATOM_BORDER_TOP,
  ATOM_SCREEN_HEIGHT, ATOM_SCREEN_WIDTH,
} from '@/machines/atom/constants.ts';

const key = (code: string, k: string, extra: Partial<HostKeyEvent> = {}): HostKeyEvent =>
  ({ code, key: k, shift: false, ctrl: false, alt: false, ...extra });

const uefChunk = (id: number, ...data: number[]): UefChunk => ({ id, data: Uint8Array.from(data) });
const pulseSum = (pulses: Uint32Array): number => pulses.reduce((a, b) => a + b, 0);

const CACHE = join(process.cwd(), 'mcp', '.cache');
const ROMS = ['atom-basic.rom', 'atom-float.rom', 'atom-kernel.rom'];
const romsAvailable = (): boolean => ROMS.every((f) => existsSync(join(CACHE, f)));

function systemRom(): Uint8Array {
  const data = new Uint8Array(0x3000);
  ROMS.forEach((f, i) => data.set(readFileSync(join(CACHE, f)), i * 0x1000));
  return data;
}

function boot(): AtomMachine {
  const m = new AtomMachine('atom', null);
  m.loadROM(systemRom());
  m.reset();
  for (let i = 0; i < 120; i++) m.tick();
  return m;
}

describe('atom registration', () => {
  it('is registered as a 6502 machine with a cassette deck and no disk service', () => {
    expect(registry).toContain(atomEntry);
    const m = new AtomMachine('atom', null);
    try {
      expect(m.kind).toBe('atom');
      expect(m.descriptor.cpuFamily).toBe('m6502');
      expect(m.services.debug.ports).toBeNull();
      expect(m.services.tape).not.toBeNull();
      expect(m.services.tape?.loaded).toBe(false);
      expect(m.services.disks).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('describes the 256x192 6847 field in its bordered buffer', () => {
    const d = atomEntry.descriptor('atom');
    expect(d.screen.width).toBe(ATOM_SCREEN_WIDTH);
    expect(d.screen.height).toBe(ATOM_SCREEN_HEIGHT);
    expect(d.screen.activeWidth).toBe(ATOM_ACTIVE_WIDTH);
    expect(d.screen.activeHeight).toBe(ATOM_ACTIVE_HEIGHT);
    expect(d.screen.borderLeft).toBe(ATOM_BORDER_LEFT);
    expect(d.screen.borderTop).toBe(ATOM_BORDER_TOP);
    expect(d.screen.width).toBe(320);
    expect(d.screen.height).toBe(240);
  });

  it('paces its frame loop at the 6847 field rate, not 50 Hz', () => {
    const m = new AtomMachine('atom', null);
    try {
      const hz = (m as unknown as { frameHz: number }).frameHz;
      expect(hz).toBeGreaterThan(59.5);
      expect(hz).toBeLessThan(60.0);
    } finally {
      m.destroy();
    }
  });

  it('names its three hosted system-ROM sources and classifies a 12 KB image', () => {
    expect(atomEntry.romSources('atom')).toEqual([
      'acorn/atom-basic.rom', 'acorn/atom-float.rom', 'acorn/atom-kernel.rom',
    ]);
    const image = new Uint8Array(0x3000);
    image[0x2FFC] = 0x3F;
    image[0x2FFD] = 0xFF;
    expect(atomEntry.detectModelForRom?.(image, 'zx48k')).toBe('atom');
    image[0x2FFC] = 0;
    image[0x2FFD] = 0;
    expect(atomEntry.detectModelForRom?.(image, 'zx48k')).toBeNull();
  });

  it('offers the native snapshot, screenshot and RAM save entries', () => {
    const ui = atomEntry.descriptor('atom').ui;
    expect(ui.saveMenu).toContain('snapshot-atomstate');
    expect(ui.saveMenu).toContain('screenshot-png');
    expect(ui.saveMenu).toContain('ram-bin');
    expect(ui.hiddenPanes).not.toContain('tape-panel');
    expect(ui.hiddenPanes).toContain('sysvar-panel');
  });
});

describe('atom memory map', () => {
  const writable = (m: AtomMachine, addr: number): boolean => {
    m.memory.writeByte(addr, 0x5A);
    return m.memory.readByte(addr) === 0x5A;
  };

  it('fits 1 KB workspace, 5 KB text RAM and 6 KB display RAM on a 12 KB machine', () => {
    const m = new AtomMachine('atom', null);
    try {
      expect(m.memory.ramKb).toBe(12);
      expect(writable(m, 0x0000)).toBe(true);
      expect(writable(m, 0x03FF)).toBe(true);
      expect(writable(m, 0x0400)).toBe(false);
      expect(writable(m, 0x27FF)).toBe(false);
      expect(writable(m, 0x2800)).toBe(true);
      expect(writable(m, 0x3BFF)).toBe(true);
      expect(writable(m, 0x3C00)).toBe(false);
      expect(writable(m, 0x8000)).toBe(true);
      expect(writable(m, 0x97FF)).toBe(true);
      expect(writable(m, 0x9800)).toBe(false);
      expect(m.memory.readByte(0x0400)).toBe(0xFF);
    } finally {
      m.destroy();
    }
  });

  it('drops the 5 KB expansion and the upper display RAM on a 2 KB machine', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.memory.setRamKb(2);
      expect(m.memory.ramKb).toBe(2);
      expect(writable(m, 0x03FF)).toBe(true);
      expect(writable(m, 0x2800)).toBe(false);
      expect(writable(m, 0x83FF)).toBe(true);
      expect(writable(m, 0x8400)).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('maps BASIC, floating point and kernel ROM read-only', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.memory.basicRom[0] = 0x11;
      m.memory.floatRom[0] = 0x22;
      m.memory.kernelRom[0] = 0x33;
      expect(m.memory.readByte(0xC000)).toBe(0x11);
      expect(m.memory.readByte(0xD000)).toBe(0x22);
      expect(m.memory.readByte(0xF000)).toBe(0x33);
      m.memory.writeByte(0xC000, 0x99);
      m.memory.writeByte(0xD000, 0x99);
      m.memory.writeByte(0xF000, 0x99);
      expect(m.memory.readByte(0xC000)).toBe(0x11);
      expect(m.memory.readByte(0xD000)).toBe(0x22);
      expect(m.memory.readByte(0xF000)).toBe(0x33);
    } finally {
      m.destroy();
    }
  });

  it('mirrors the PPI and VIA through their 1 KB blocks', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.memory.writeByte(0xB003, 0x8A);
      expect(m.ppi.control).toBe(0x8A);
      expect(m.memory.readByte(0xB007)).toBe(0x8A);
      expect(m.memory.readByte(0xB3FF)).toBe(0x8A);
      m.memory.writeByte(0xB80B, 0x80);      // VIA ACR
      expect(m.memory.readByte(0xB80B)).toBe(0x80);
      expect(m.memory.readByte(0xB85B)).toBe(0x80);
      expect(m.memory.readByte(0xB8FB)).toBe(0x80);
    } finally {
      m.destroy();
    }
  });

  it('reads unconnected space as open bus', () => {
    const m = new AtomMachine('atom', null);
    try {
      expect(m.memory.readByte(0x0400)).toBe(0xFF);
      expect(m.memory.readByte(0xA000)).toBe(0xFF);
      expect(m.memory.readByte(0xE000)).toBe(0xFF);
    } finally {
      m.destroy();
    }
  });

  it('parses the Hardware-pane RAM setting, defaulting to 12 KB', () => {
    expect(parseAtomRam('2k')).toBe(2);
    expect(parseAtomRam('12k')).toBe(12);
    expect(parseAtomRam('nonsense')).toBe(12);
    expect(parseAtomRam(undefined)).toBe(12);
  });
});

describe('atom keyboard', () => {
  it('reads idle rows as all switches open', () => {
    const k = new AtomKeyboard();
    expect(k.readRow(0)).toBe(0xFF);
    expect(k.readRow(9)).toBe(0xFF);
  });

  it('maps a digit and a letter to the Atom matrix cells', () => {
    const k = new AtomKeyboard();
    k.handleEvent(key('Digit3', '3'), true);
    expect(k.readRow(0)).toBe(0xFD);          // row 0, column 1
    k.handleEvent(key('Digit3', '3'), false);
    k.handleEvent(key('KeyP', 'p'), true);
    expect(k.readRow(1)).toBe(0xEF);          // row 1, column 4
  });

  it('sets SHIFT for the Atom symbol that needs it', () => {
    const k = new AtomKeyboard();
    k.handleEvent(key('Digit2', '"', { shift: true }), true);
    // Row 1 column 1, plus SHIFT on bit 7.
    expect(k.readRow(1)).toBe(0x7D);
    // Releasing the symbol key while the host's Shift is still held leaves the
    // Atom's SHIFT line asserted, as the separate Shift key would.
    k.handleEvent(key('Digit2', '"', { shift: true }), false);
    expect(k.readRow(1)).toBe(0x7F);
    k.handleEvent(key('ShiftLeft', 'Shift', { shift: true }), true);
    k.handleEvent(key('ShiftLeft', 'Shift', { shift: false }), false);
    expect(k.readRow(1)).toBe(0xFF);
  });

  it('keeps CTRL on the left key and REPT on the right key', () => {
    const k = new AtomKeyboard();
    k.handleEvent(key('ControlLeft', 'Control', { ctrl: true }), true);
    expect(k.readRow(0)).toBe(0xBF);
    k.handleEvent(key('ControlLeft', 'Control', { ctrl: true }), false);
    k.handleEvent(key('ControlRight', 'Control', { ctrl: true }), true);
    expect(k.ctrlHeld).toBe(false);
    expect(k.repeat).toBe(true);
    expect(k.readRow(0)).toBe(0xFF);
  });

  it('types a character and releases it', () => {
    const k = new AtomKeyboard();
    expect(k.pressChar('P')).toBe(true);
    expect(k.readRow(1)).toBe(0xEF);
    k.releaseAll();
    expect(k.readRow(1)).toBe(0xFF);
    expect(k.pressChar('~')).toBe(true);     // SHIFT + the Arrow key cell
    expect(k.shiftHeld).toBe(true);
    expect(k.readRow(5)).toBe(0x7E);
    k.releaseAll();
    expect(k.pressChar('€')).toBe(false);
  });
});

describe('atom cassette', () => {
  it('declares the deck transport and the UEF/CSW/WAVE set', () => {
    const m = new AtomMachine('atom', null);
    try {
      const exts = m.services.media.accepts().map(t => t.ext);
      expect(exts).toEqual(expect.arrayContaining([...ATOM_TAPE_EXTENSIONS]));
      const ui = atomEntry.descriptor('atom').ui;
      expect(ui.tape).toBe('deck');
      expect(ui.tapeExtensions).toEqual([...ATOM_TAPE_EXTENSIONS]);
      expect(ui.hiddenPanes).not.toContain('tape-panel');
    } finally {
      m.destroy();
    }
  });

  it('decodes an Atom UEF at 300 baud with the nominal 1200 Hz base', async () => {
    // The image declares a measured 1500 Hz base; the Atom's receiver expects
    // the nominal 1200 Hz, and its tapes carry no 0x0117 baud chunk, so the
    // default is 300 baud. One 0x00 byte is then exactly 10/300 s:
    //   start + eight zero bits = 36 cycles at 1200 Hz, stop = 8 cycles at 2400 Hz.
    const data = buildUef([
      { id: 0x0113, data: new Uint8Array(new Float32Array([1500]).buffer) },
      uefChunk(0x0100, 0x00),
    ]);
    const blocks = await parseAtomTape(data);
    expect(blocks).toHaveLength(1);
    const pulses = (blocks[0] as CswBlock).pulses;
    expect(Math.abs(pulseSum(pulses) - TAPE_REF_HZ * 10 / 300)).toBeLessThanOrEqual(1);
  });

  it('mounts a tape and feeds its level to PPI port C bit 5', async () => {
    const m = new AtomMachine('atom', null);
    try {
      m.reset();
      m.memory.writeByte(0xB003, 0x8A);       // A out, B in, C upper in / lower out
      const mounted = await m.services.media.mount(
        buildUef([uefChunk(0x0110, 0x60, 0x09)]), 'tone.uef');   // 1 s of 2400 Hz
      expect(mounted).toMatchObject({ ok: true, target: 'tape' });
      const tape = m.services.tape!;
      expect(tape.loaded).toBe(true);
      expect(tape.name).toBe('tone.uef');
      expect(tape.playing).toBe(true);
      expect(tape.blocks).toHaveLength(1);
      const levels = new Set<number>();
      for (let i = 0; i < 60; i++) {
        levels.add((m.memory.readByte(0xB002) >> 5) & 1);
        tape.advance(250);
      }
      // A 2400 Hz half-cycle is ~208 CPU cycles, so 15 000 cycles see both
      // polarities of the cassette input.
      expect(levels).toEqual(new Set([0, 1]));
      const out = createFrameIndicators();
      m.services.probe.frameTick?.(out);
      m.services.probe.sample(out);
      expect(out.tapeLoaded).toBe(true);
      expect(out.tapePlaying).toBe(true);
      // The EAR lamp follows level changes, not the idle-high CASIN line.
      expect(out.tapeIn).toBe(1);
      tape.stop();
      m.services.probe.frameTick?.(out);
      m.services.probe.sample(out);
      expect(out.tapeIn).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('rejects a file that is not a cassette image', async () => {
    const m = new AtomMachine('atom', null);
    try {
      const result = await m.services.media.mount(new Uint8Array(64).fill(0x55), 'broken.uef');
      expect(result.ok).toBe(false);
      expect(m.services.tape!.loaded).toBe(false);
    } finally {
      m.destroy();
    }
  });
});

describe('atom on-screen keyboard', () => {
  const rows = (): string[][] => {
    const byY = new Map<number, { x: number; main: string }[]>();
    for (const { key, box } of placeDeckKeys()) {
      const row = byY.get(box.y) ?? [];
      row.push({ x: box.x, main: key.main });
      byY.set(box.y, row);
    }
    return [...byY.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, row]) => row.sort((a, b) => a.x - b.x).map((entry) => entry.main));
  };

  it('places every cap exactly once inside the scene', () => {
    const placed = placeDeckKeys();
    expect(placed).toHaveLength(DECK_KEYS.length);
    expect(new Set(placed.map(p => p.key.id)).size).toBe(DECK_KEYS.length);
    for (const { box } of placed) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(DECK_SCENE.width);
      expect(box.y + box.height).toBeLessThanOrEqual(DECK_SCENE.height);
    }
  });

  it('lays the caps out as the Atom physical QWERTY deck', () => {
    // From the machine's keyboard: ESC and the number row, the Q row with the
    // left/right arrow and COPY, the A row with CTRL and RETURN, the Z row with
    // two SHIFTs and REPT, then the space bar.
    expect(rows()).toEqual([
      ['ESC', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', ':', '↑', 'BREAK'],
      ['↔', 'COPY', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '@', '\\', 'DELETE'],
      ['↕', 'CTRL', 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', '[', ']', 'RETURN'],
      ['LOCK', 'SHIFT', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'SHIFT', 'REPT'],
      [''],
    ]);
  });

  it('staggers the rows like the machine instead of stacking them', () => {
    const byY = new Map<number, { x: number; w: number }[]>();
    for (const { box } of placeDeckKeys()) {
      const row = byY.get(box.y) ?? [];
      row.push({ x: box.x, w: box.width });
      byY.set(box.y, row);
    }
    const row = (n: number) => byY.get([...byY.keys()].sort((a, b) => a - b)[n])!
      .sort((a, b) => a.x - b.x);
    const left = (n: number) => row(n)[0].x;
    const right = (n: number) => {
      const r = row(n);
      return r[r.length - 1].x + r[r.length - 1].w;
    };
    // The Q row is leftmost; the A row steps in a quarter key, the number row
    // further, and the Z row almost a whole key.
    expect(left(1)).toBeLessThan(left(2));
    expect(left(2)).toBeLessThan(left(0));
    expect(left(0)).toBeLessThan(left(3));
    // The same stagger shows on the right: BREAK reaches furthest, then RETURN,
    // DELETE, and REPT last.
    expect(right(0)).toBeGreaterThan(right(2));
    expect(right(2)).toBeGreaterThan(right(1));
    expect(right(1)).toBeGreaterThan(right(3));
    // The Z row keeps the same cap pitch as the other rows.
    const z = row(3);
    expect(z[1].x - z[0].x).toBe(z[2].x - z[1].x);
    expect(z[1].x - z[0].x).toBe(row(1)[1].x - row(1)[0].x);
    // The space bar sits a normal row gap below the Z row, not a key higher.
    const space = placeDeckKeys().find(p => p.key.region === 'space')!;
    const zed = placeDeckKeys().find(p => p.key.main === 'Z')!;
    expect(space.box.y - (zed.box.y + zed.box.height)).toBeLessThan(10);
  });

  it('puts every cap on its Atom matrix cell and keeps the unused cells empty', () => {
    const cells = new Map<string, string>();
    for (const key of DECK_KEYS) {
      if (key.row < 0) continue;
      expect(key.row).toBeGreaterThanOrEqual(0);
      expect(key.row).toBeLessThanOrEqual(9);
      expect(key.col).toBeGreaterThanOrEqual(0);
      expect(key.col).toBeLessThanOrEqual(5);
      const cell = `${key.row},${key.col}`;
      expect(cells.has(cell)).toBe(false);
      cells.set(cell, key.main);
    }
    // 55 of the matrix's 60 crosspoints are keys; the other five are unused.
    expect(cells.size).toBe(55);
    expect(cells.get('0,5')).toBe('ESC');
    expect(cells.get('0,4')).toBe('Q');
    expect(cells.get('4,5')).toBe('W');
    expect(cells.get('6,3')).toBe('A');
    expect(cells.get('1,5')).toBe('Z');
    expect(cells.get('5,0')).toBe('↑');
    expect(cells.get('9,0')).toBe('');
  });

  it('keeps the 26 letters and the SHIFT/CTRL/REPT/BREAK actions', () => {
    expect(DECK_KEYS.filter(k => k.region === 'letter')).toHaveLength(26);
    expect(DECK_KEYS.filter(k => k.action === 'shift')).toHaveLength(2);
    expect(DECK_KEYS.filter(k => k.action === 'ctrl')).toHaveLength(1);
    expect(DECK_KEYS.filter(k => k.action === 'rept')).toHaveLength(1);
    expect(DECK_KEYS.filter(k => k.action === 'break')).toHaveLength(1);
    // Only the space bar is wider than one cap, and the badge sits beside it.
    const wide = placeDeckKeys().filter(p => p.box.width > p.box.height * 1.5);
    expect(wide.map(p => p.key.region)).toEqual(['space']);
    expect(wide[0].box.x + wide[0].box.width).toBeLessThan(DECK_BADGE_BOX.x);
  });

  it('is registered as a Keyboard UI contribution', () => {
    expect(machineUi('atom').Keyboard).toBeDefined();
    expect(machineUi('atom').HardwareSection).toBeDefined();
  });
});

describe('atom OCR mapping', () => {
  it('maps the Atom VDG codes to ASCII', () => {
    expect(atomCodeToAscii(0x01)).toBe('A');
    expect(atomCodeToAscii(0x10)).toBe('P');
    expect(atomCodeToAscii(0x1A)).toBe('Z');
    expect(atomCodeToAscii(0x20)).toBe(' ');
    expect(atomCodeToAscii(0x3F)).toBe('?');
    expect(atomCodeToAscii(0x81)).toBe('A');
    expect(atomCodeToAscii(0x40)).toBeNull();  // semigraphics
    expect(atomCodeToAscii(0xC0)).toBeNull();
  });

  it('marks inverse video and builds a 32x16 grid', () => {
    expect(atomCodeIsInverse(0x81)).toBe(true);
    expect(atomCodeIsInverse(0x41)).toBe(false);
    expect(atomCodeIsInverse(0x01)).toBe(false);
    const screen = new Uint8Array(512).fill(0x20);
    screen[0] = 0x01;
    screen[1] = 0x10;
    screen[2] = 0x81;
    const result = ocrAtomText(screen);
    expect(result.grid).toBe('32x16');
    expect(result.cols).toBe(32);
    expect(result.rows).toBe(16);
    expect(result.cellWidth).toBe(8);
    expect(result.cellHeight).toBe(12);
    expect(result.text.split('\n')[0]).toBe('APA' + ' '.repeat(29));
    expect(result.mask[0]).toBe(true);
    expect(result.mask[3]).toBe(false);
  });
});

describe('atom display', () => {
  it('decodes the port-A mode pins into the 6847 mode', () => {
    const m = new AtomMachine('atom', null);
    try {
      // The Atom's PPI control word: A out, B in, C upper in / lower out.
      m.memory.writeByte(0xB003, 0x8A);
      m.memory.writeByte(0xB000, 0x10);
      expect(m.vdg.modeName).toBe('64x64 4-colour');
      m.memory.writeByte(0xB000, 0x70);
      expect(m.vdg.modeName).toBe('128x96 2-colour');
      m.memory.writeByte(0xB000, 0xB0);
      expect(m.vdg.modeName).toBe('128x192 2-colour');
      m.memory.writeByte(0xB000, 0xF0);
      expect(m.vdg.modeName).toBe('256x192 2-colour');
    } finally {
      m.destroy();
    }
  });

  it('fills the active field and leaves the border black', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.memory.writeByte(0xB003, 0x8A);
      m.memory.writeByte(0xB000, 0xF0);          // 256x192 two-colour
      for (let i = 0; i < 0x1800; i++) m.memory.writeByte(0x8000 + i, 0xFF);
      m.video.render(m.vdg, m.memory.vram);
      let lit = 0;
      for (const p of m.video.pixels32) if (p !== 0xFF000000) lit++;
      expect(lit).toBe(ATOM_ACTIVE_WIDTH * ATOM_ACTIVE_HEIGHT);
      expect(m.video.pixels32[0]).toBe(0xFF000000); // top-left border
    } finally {
      m.destroy();
    }
  });
});

describe('atom frame probe', () => {
  it('reports keyboard polling and speaker activity', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.reset();
      m.memory.readByte(0xB001);
      m.memory.readByte(0xB001);
      const out = createFrameIndicators();
      m.services.probe.frameTick?.(out);
      m.services.probe.sample(out);
      expect(out.keyboard).toBe(2);
      expect(out.tapeLoaded).toBe(false);
      expect(out.tapeIn).toBe(0);          // idle CASIN is high, but not activity
      expect(out.mdvCount).toBe(0);
    } finally {
      m.destroy();
    }
  });
});

const roms = romsAvailable();
(roms ? describe : describe.skip)('atom boot (Acorn ROMs)', () => {
  it('boots to the ACORN ATOM banner and the BASIC prompt', () => {
    const m = boot();
    try {
      const screen = m.ocrScreenForMcp();
      expect(screen).toContain('ACORN ATOM');
      expect(screen.split('\n').pop()).toBe('>');
    } finally {
      m.destroy();
    }
  });

  it('types a PRINT and shows its result', () => {
    const m = boot();
    try {
      m.typeText('PRINT "HI"\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 60; i++) m.tick();
      const screen = m.ocrScreenForMcp();
      expect(screen).toContain('PRINT "HI"');
      expect(screen).toContain('HI');
      expect(m.pasteRemaining).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('parses the typed BASIC listing and its variables from the text space', () => {
    const m = boot();
    try {
      m.typeText('10 A=42\n20 END\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 30; i++) m.tick();
      expect(m.services.probe.panes?.basicListing?.()).toEqual([
        { lineNumber: 10, text: ' A=42' },
        { lineNumber: 20, text: ' END' },
      ]);
      m.typeText('RUN\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 60; i++) m.tick();
      expect(m.services.probe.panes?.basicVars?.()).toContainEqual(
        { name: 'A', kind: 'number', value: '42' },
      );
    } finally {
      m.destroy();
    }
  });

  it('reports a dimensioned AA array from a real DIM', () => {
    const m = boot();
    try {
      m.typeText('10 DIM AA(4)\n20 END\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 30; i++) m.tick();
      m.typeText('RUN\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 60; i++) m.tick();
      expect(m.services.probe.panes?.basicVars?.()).toContainEqual(
        expect.objectContaining({ name: 'AA(4)', kind: 'array' }),
      );
    } finally {
      m.destroy();
    }
  });

  it('switches to 256x192 and draws through CLEAR/DRAW', () => {
    const m = boot();
    try {
      m.typeText('CLEAR 4\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 30; i++) m.tick();
      expect(m.vdg.modeName).toBe('256x192 2-colour');

      m.typeText('MOVE 0,0\nDRAW 255,191\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 30; i++) m.tick();
      let lit = 0;
      for (const p of m.video.pixels32) if (p !== 0xFF000000) lit++;
      // A diagonal across the field is roughly 256 lit pixels; the text
      // cursor and border leave the total above 200 and well below a filled
      // screen.
      expect(lit).toBeGreaterThan(200);
      expect(lit).toBeLessThan(1000);
      expect(m.ocrScreenForMcp()).toBe('');
    } finally {
      m.destroy();
    }
  });

  it('boots the 2 KB machine with its text space at $8200', () => {
    const m = new AtomMachine('atom', null);
    try {
      m.loadROM(systemRom());
      m.prepare({ get: <T,>(key: string, fallback: T): T => (key === 'atom-ram' ? ('2k' as T) : fallback) });
      m.reset();
      for (let i = 0; i < 120; i++) m.tick();
      expect(m.memory.ramKb).toBe(2);
      expect(m.ocrScreenForMcp()).toContain('ACORN ATOM');
      m.typeText('10 PRINT 1\n');
      for (let i = 0; i < 800 && m.pasteRemaining > 0; i++) m.tick();
      for (let i = 0; i < 30; i++) m.tick();
      expect(m.services.probe.panes?.basicListing?.()).toEqual([{ lineNumber: 10, text: ' PRINT 1' }]);
    } finally {
      m.destroy();
    }
  });

  it('round-trips its native snapshot', async () => {
    const m = boot();
    try {
      m.memory.writeByte(0x0300, 0xAB);
      const state = m.services.snapshots!.saveSync!();
      expect(state).toBeInstanceOf(Uint8Array);
      m.memory.writeByte(0x0300, 0xCD);
      expect(await m.services.snapshots!.restoreSync!(state)).toBe(true);
      expect(m.memory.readByte(0x0300)).toBe(0xAB);
    } finally {
      m.destroy();
    }
  });

  it('reports a transcribe grid from the text screen', () => {
    const m = boot();
    try {
      const result = m.services.probe.transcribe!.run();
      expect(result.grid).toBe('32x16');
      expect(result.text).toContain('ACORN ATOM');
    } finally {
      m.destroy();
    }
  });
});

const BREAKOUT_UEF = join(CACHE, 'atom-breakout.uef');
const haveBreakout = romsAvailable() && existsSync(BREAKOUT_UEF);

(haveBreakout ? describe : describe.skip)('atom tape load (Breakout UEF)', () => {
  it('loads a real cassette image into the BASIC text space', async () => {
    const m = boot();
    try {
      const mounted = await m.services.media.mount(
        new Uint8Array(readFileSync(BREAKOUT_UEF)), 'atom-breakout.uef');
      expect(mounted).toMatchObject({ ok: true, target: 'tape' });
      const tape = m.services.tape!;
      expect(tape.loaded).toBe(true);
      expect(tape.playing).toBe(true);

      // LOAD prints PLAY TAPE and waits for a key; the tape runs from the
      // moment it is mounted, as a recorder left playing would.
      m.typeText('LOAD "BREAKOUT"\n');
      let guard = 0;
      while (guard++ < 6000 && !m.ocrScreenForMcp().includes('PLAY TAPE')) m.tick();
      expect(m.ocrScreenForMcp()).toContain('PLAY TAPE');

      m.keyboard.pressChar(' ');
      for (let i = 0; i < 8; i++) m.tick();
      m.keyboard.releaseAll();

      let listing = m.services.probe.panes?.basicListing?.() ?? [];
      let screen = '';
      for (let i = 0; i < 24000; i += 250) {
        for (let j = 0; j < 250; j++) m.tick();
        screen = m.ocrScreenForMcp();
        if (screen.includes('SUM') || screen.includes('ERROR')) break;
        listing = m.services.probe.panes?.basicListing?.() ?? [];
        // The file is a two-line BASIC loader followed by a machine-code block;
        // the OS returns to the prompt when the last block is in.
        if (listing.length > 0 && screen.split('\n').pop() === '>') break;
      }

      expect(screen).not.toMatch(/SUM|ERROR/);
      expect(listing.map(l => l.lineNumber)).toEqual([1, 2]);
      expect(listing[0].text).toContain('WHICH SKILL LEVEL');
      expect(m.services.probe.panes?.basicVars?.()).toEqual([]);
      expect(tape.position).toBeGreaterThan(0);
    } finally {
      m.destroy();
    }
  }, 120_000);
});

