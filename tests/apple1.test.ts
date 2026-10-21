/**
 * Apple I integration tests — registration, memory map, the PIA-driven keyboard
 * and terminal, and the Woz Monitor running on the real memory map. The Monitor
 * is the published 256-byte PROM listing; it exercises the busy-flag handshake,
 * the keyboard strobe and the ECHO routine the way real software does.
 */

import { describe, it, expect } from 'vitest';
import { Apple1Machine } from '@/machines/apple1/apple1-machine.ts';
import { apple1Entry } from '@/machines/apple1/descriptor.ts';
import { parseApple1Ram } from '@/machines/apple1/options.ts';
import { apple1FaceByte, apple1KeyByte, apple1PasteBytes } from '@/machines/apple1/apple1-keyboard.ts';
import { APPLE1_KEYS, APPLE1_SCENE, placeApple1Keys } from '@/machines/apple1/ui/keyboard/layout.ts';
import { Apple1Terminal } from '@/machines/apple1/apple1-terminal.ts';
import {
  APPLE1_BORDER_LEFT, APPLE1_BORDER_TOP, APPLE1_CELL_HEIGHT, APPLE1_CELL_WIDTH, APPLE1_CHAR_CYCLES,
  APPLE1_SCREEN_WIDTH,
} from '@/machines/apple1/constants.ts';
import { createFrameIndicators } from '@/machines/machine.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';
import { registry } from '@/machines/registry.ts';

const key = (code: string, k: string, extra: Partial<HostKeyEvent> = {}): HostKeyEvent =>
  ({ code, key: k, shift: false, ctrl: false, alt: false, ...extra });

/** The Woz Monitor, $FF00-$FFFF. */
const WOZMON = new Uint8Array([
  0xD8, 0x58, 0xA0, 0x7F, 0x8C, 0x12, 0xD0, 0xA9, 0xA7, 0x8D, 0x11, 0xD0, 0x8D, 0x13, 0xD0, 0xC9,
  0xDF, 0xF0, 0x13, 0xC9, 0x9B, 0xF0, 0x03, 0xC8, 0x10, 0x0F, 0xA9, 0xDC, 0x20, 0xEF, 0xFF, 0xA9,
  0x8D, 0x20, 0xEF, 0xFF, 0xA0, 0x01, 0x88, 0x30, 0xF6, 0xAD, 0x11, 0xD0, 0x10, 0xFB, 0xAD, 0x10,
  0xD0, 0x99, 0x00, 0x02, 0x20, 0xEF, 0xFF, 0xC9, 0x8D, 0xD0, 0xD4, 0xA0, 0xFF, 0xA9, 0x00, 0xAA,
  0x0A, 0x85, 0x2B, 0xC8, 0xB9, 0x00, 0x02, 0xC9, 0x8D, 0xF0, 0xD4, 0xC9, 0xAE, 0x90, 0xF4, 0xF0,
  0xF0, 0xC9, 0xBA, 0xF0, 0xEB, 0xC9, 0xD2, 0xF0, 0x3B, 0x86, 0x28, 0x86, 0x29, 0x84, 0x2A, 0xB9,
  0x00, 0x02, 0x49, 0xB0, 0xC9, 0x0A, 0x90, 0x06, 0x69, 0x88, 0xC9, 0xFA, 0x90, 0x11, 0x0A, 0x0A,
  0x0A, 0x0A, 0xA2, 0x04, 0x0A, 0x26, 0x28, 0x26, 0x29, 0xCA, 0xD0, 0xF8, 0xC8, 0xD0, 0xE0, 0xC4,
  0x2A, 0xF0, 0x97, 0x24, 0x2B, 0x50, 0x10, 0xA5, 0x28, 0x81, 0x26, 0xE6, 0x26, 0xD0, 0xB5, 0xE6,
  0x27, 0x4C, 0x44, 0xFF, 0x6C, 0x24, 0x00, 0x30, 0x2B, 0xA2, 0x02, 0xB5, 0x27, 0x95, 0x25, 0x95,
  0x23, 0xCA, 0xD0, 0xF7, 0xD0, 0x14, 0xA9, 0x8D, 0x20, 0xEF, 0xFF, 0xA5, 0x25, 0x20, 0xDC, 0xFF,
  0xA5, 0x24, 0x20, 0xDC, 0xFF, 0xA9, 0xBA, 0x20, 0xEF, 0xFF, 0xA9, 0xA0, 0x20, 0xEF, 0xFF, 0xA1,
  0x24, 0x20, 0xDC, 0xFF, 0x86, 0x2B, 0xA5, 0x24, 0xC5, 0x28, 0xA5, 0x25, 0xE5, 0x29, 0xB0, 0xC1,
  0xE6, 0x24, 0xD0, 0x02, 0xE6, 0x25, 0xA5, 0x24, 0x29, 0x07, 0x10, 0xC8, 0x48, 0x4A, 0x4A, 0x4A,
  0x4A, 0x20, 0xE5, 0xFF, 0x68, 0x29, 0x0F, 0x09, 0xB0, 0xC9, 0xBA, 0x90, 0x02, 0x69, 0x06, 0x2C,
  0x12, 0xD0, 0x30, 0xFB, 0x8D, 0x12, 0xD0, 0x60, 0x00, 0x00, 0x00, 0x0F, 0x00, 0xFF, 0x00, 0x00,
]);

/** The Monitor's NEXTCHAR loop: it has printed everything and wants a key. */
const waitingForKey = (m: Apple1Machine): boolean =>
  m.cpu.pc >= 0xFF29 && m.cpu.pc <= 0xFF2D && !m.displayBusy;

/** Run frames until the Monitor is idle at its keyboard poll. */
function settle(m: Apple1Machine, limit = 400): void {
  for (let i = 0; i < limit && !waitingForKey(m); i++) m.tick();
  expect(waitingForKey(m)).toBe(true);
}

/** A reset Monitor, idle at its prompt. */
function boot(): Apple1Machine {
  const m = new Apple1Machine('apple1', null);
  m.loadROM(WOZMON);
  m.reset();
  settle(m);
  return m;
}

/** Type like a person: a key, then wait for the Monitor to take it and finish echoing. */
function typeLine(m: Apple1Machine, text: string): void {
  for (const ch of text) {
    m.keyboard.press(ch === '\n' ? 0x0D : ch.toUpperCase().charCodeAt(0));
    m.tick();
    settle(m);
  }
}

describe('apple1 registration', () => {
  it('is registered as a 6502 machine with no I/O ports', () => {
    expect(registry).toContain(apple1Entry);
    const m = new Apple1Machine('apple1', null);
    try {
      expect(m.kind).toBe('apple1');
      expect(m.descriptor.cpuFamily).toBe('m6502');
      expect(m.services.debug.ports).toBeNull();
      expect(m.services.tape).toBeNull();
      expect(m.services.disks).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('claims a bare 256-byte ROM image and names its source', () => {
    expect(apple1Entry.detectModelForRom?.(new Uint8Array(256), 'zx48k')).toBe('apple1');
    expect(apple1Entry.detectModelForRom?.(new Uint8Array(0x3000), 'zx48k')).toBeNull();
    expect(apple1Entry.romSources('apple1')).toEqual(['apple1/apple1.rom']);
  });

  it('paces its frame loop at its own field rate, not 50 Hz', () => {
    const m = new Apple1Machine('apple1', null);
    try {
      const hz = (m as unknown as { frameHz: number }).frameHz;
      expect(hz).toBeGreaterThan(59.9);
      expect(hz).toBeLessThan(60.2);
    } finally {
      m.destroy();
    }
  });
});

describe('apple1 memory map', () => {
  it('has RAM from $0000, ROM at the top page and unmapped space between', () => {
    const m = new Apple1Machine('apple1', null);
    m.loadROM(WOZMON);
    const mem = m.memory;
    mem.writeByte(0x0000, 0x12);
    mem.writeByte(0x1FFF, 0x34);
    expect(mem.readByte(0x0000)).toBe(0x12);
    expect(mem.readByte(0x1FFF)).toBe(0x34);
    mem.writeByte(0x2000, 0x56);                 // beyond the 8K fitted
    expect(mem.readByte(0x2000)).toBe(0xFF);
    mem.writeByte(0xFF00, 0x99);                 // ROM ignores writes
    expect(mem.readByte(0xFF00)).toBe(0xD8);
    expect(mem.readByte(0xFFFC)).toBe(0x00);
    expect(mem.readByte(0xFFFD)).toBe(0xFF);
    m.destroy();
  });

  it('decodes the PIA through the $Dxxx page with address bit 4', () => {
    const m = new Apple1Machine('apple1', null);
    m.memory.writeByte(0xD013, 0x04);            // CRB: data register selected
    expect(m.memory.readByte(0xD013)).toBe(0x04);
    expect(m.memory.readByte(0xD033)).toBe(0x04); // mirror
    expect(m.memory.readByte(0xD003)).toBe(0xFF); // bit 4 clear: nothing there
    m.destroy();
  });

  it('lets the debugger peek the PIA without disturbing it', () => {
    const m = boot();
    m.keyboard.press(0x41);
    const before = m.pia.cra;
    expect(m.memory.peekByte?.(0xD010)).toBe(0xC1);
    expect(m.pia.cra).toBe(before);
    m.destroy();
  });
});

describe('apple1 memory options', () => {
  const settingsView = (values: Record<string, unknown>) => ({
    get: <T>(k: string, f: T): T => (k in values ? values[k] as T : f),
  });
  const fitted = (values: Record<string, unknown>): Apple1Machine => {
    const m = new Apple1Machine('apple1', null);
    m.prepare(settingsView(values));
    return m;
  };
  const writable = (m: Apple1Machine, addr: number): boolean => {
    m.memory.writeByte(addr, 0x5A);
    return m.memory.readByte(addr) === 0x5A;
  };

  it('defaults to 8K plus the 4K BASIC card', () => {
    const m = new Apple1Machine('apple1', null);
    expect(m.memory.ramKb).toBe(8);
    expect(writable(m, 0x1FFF)).toBe(true);
    expect(writable(m, 0x2000)).toBe(false);
    expect(writable(m, 0xE000)).toBe(true);
    expect(writable(m, 0xEFFF)).toBe(true);
    expect(writable(m, 0xF000)).toBe(false);
    m.destroy();
  });

  it.each([
    ['4k', 4], ['8k', 8], ['16k', 16], ['32k', 32], ['48k', 48],
  ])('fits %s of RAM from $0000 and no more', (setting, kb) => {
    const m = fitted({ 'apple1-ram': setting });
    expect(m.memory.ramKb).toBe(kb);
    expect(writable(m, kb * 1024 - 1)).toBe(true);
    expect(writable(m, kb * 1024)).toBe(false);
    m.destroy();
  });

  it('leaves $E000 unmapped without the BASIC card, and reads it as $FF', () => {
    const m = fitted({ 'apple1-basic-ram': false });
    expect(m.memory.basicRam).toBe(false);
    expect(writable(m, 0xE000)).toBe(false);
    expect(m.memory.readByte(0xE000)).toBe(0xFF);
    m.destroy();
  });

  it('keeps the BASIC card separate from the contiguous RAM size', () => {
    const m = fitted({ 'apple1-ram': '4k', 'apple1-basic-ram': true });
    expect(writable(m, 0x1000)).toBe(false);
    expect(writable(m, 0xE000)).toBe(true);
    m.destroy();
  });

  it('falls back to the default for an unrecognised size', () => {
    expect(parseApple1Ram('64k')).toBe(8);
    expect(parseApple1Ram(undefined)).toBe(8);
    expect(parseApple1Ram('16k')).toBe(16);
  });

  it('lets the Monitor store into and examine the BASIC card', () => {
    const m = boot();
    typeLine(m, 'E000: A9 41\n');
    typeLine(m, 'E000\n');
    expect(m.memory.readByte(0xE000)).toBe(0xA9);
    expect(m.memory.readByte(0xE001)).toBe(0x41);
    expect(m.ocrScreenForMcp().split('\n')).toContain('E000: A9');
    m.destroy();
  });

  it('exports only the RAM that is fitted from $0000', () => {
    const m = fitted({ 'apple1-ram': '16k' });
    const out = m.ramExportBytes();
    expect(out.data.length).toBe(16 * 1024);
    expect(out.filename).toBe('apple1-ram-16k.bin');
    m.destroy();
  });
});

describe('apple1 listings', () => {
  /** Frames until the queue is empty and the Monitor is idle again. */
  const finish = (m: Apple1Machine, limit = 3000): number => {
    let frames = 0;
    while (frames < limit && (m.pasteRemaining > 0 || !waitingForKey(m))) { m.tick(); frames++; }
    return frames;
  };
  const text = (s: string): Uint8Array => new TextEncoder().encode(s);

  it('turns a listing into key presses: one RETURN per line ending, upper case, no stray characters', () => {
    const keys = [...apple1PasteBytes('0280: a9 00\r\n280r\nx\t1é{\n')];
    expect(String.fromCharCode(...keys)).toBe('0280: A9 00\r280R\rX 1\r');
    expect([...apple1PasteBytes('﻿A')]).toEqual([0x41]);
  });

  it('keys a hex dump into the Monitor and runs it', () => {
    const m = boot();
    const listing = '280: A9 C8 20 EF FF 4C 1F FF\n280R\n';
    expect(m.typeText(listing)).toBe(listing.length);
    finish(m);
    expect(m.pasteRemaining).toBe(0);
    expect([...m.memory.readBlock(0x280, 8)]).toEqual([0xA9, 0xC8, 0x20, 0xEF, 0xFF, 0x4C, 0x1F, 0xFF]);
    expect(m.ocrScreenForMcp().split('\n')).toContain('0280: A9H');
    m.destroy();
  });

  it('types no faster than the terminal can echo', () => {
    const m = boot();
    const listing = '300: 11 22 33 44 55 66 77 88\n';
    m.typeText(listing);
    const start = m.cpu.tStates;
    finish(m);
    expect((m.cpu.tStates - start) / m.cpuClockHz).toBeGreaterThan(listing.length / 61);
    m.destroy();
  });

  it('holds a key back while the program has not taken the last one', () => {
    const m = boot();
    m.keyboard.press(0x41);                      // waiting in the latch, unread
    m.typeText('BC');
    expect(m.pia.cra & 0x80).toBe(0x80);         // the strobe set KBDCR bit 7
    const before = m.pasteRemaining;
    (m as unknown as { feedPaste(): void }).feedPaste();
    expect(m.pasteRemaining).toBe(before);
    m.destroy();
  });

  it('is dropped by RESET and by a machine reset', () => {
    const m = boot();
    m.typeText('1234567890');
    m.tick();
    expect(m.pasteRemaining).toBeGreaterThan(0);
    m.pressResetKey();
    expect(m.pasteRemaining).toBe(0);
    m.typeText('ABC');
    m.reset();
    expect(m.pasteRemaining).toBe(0);
    m.destroy();
  });

  it('is what mounting a .txt or .hex file does', async () => {
    const m = boot();
    const ok = await m.services.media.mount(text('300: AA\n'), 'prog.TXT');
    expect(ok).toMatchObject({ ok: true, target: 'paste' });
    finish(m);
    expect(m.memory.readByte(0x300)).toBe(0xAA);
    expect((await m.services.media.mount(text('301: BB\r\n'), 'prog.hex')).ok).toBe(true);
    finish(m);
    expect(m.memory.readByte(0x301)).toBe(0xBB);
    expect(m.services.media.accepts().map(t => t.ext)).toEqual(['.txt', '.hex']);
    m.destroy();
  });

  it('refuses other files, and listings with nothing typeable', async () => {
    const m = boot();
    expect((await m.services.media.mount(text('x'), 'game.tap')).ok).toBe(false);
    expect((await m.services.media.mount(text('{}~'), 'empty.txt')).ok).toBe(false);
    m.destroy();
  });
});

describe('apple1 cassette interface', () => {
  const view = (values: Record<string, unknown>) => ({
    get: <T>(k: string, f: T): T => (k in values ? values[k] as T : f),
  });
  /** A machine with the interface fitted and its ROM (page of $A5 bytes) loaded. */
  function withAci(): Apple1Machine {
    const m = new Apple1Machine('apple1', null);
    const requests = m.prepare(view({ 'apple1-aci': true }));
    requests.find(r => r.source === 'apple1/aci.rom')!.apply(new Uint8Array(256).fill(0xA5));
    return m;
  }
  /** 8-bit mono WAV of `halves` alternating half-waves, each `len` samples long, high first. */
  function square(halves: number, len: number): Uint8Array {
    const n = halves * len;
    const out = new Uint8Array(44 + n);
    const v = new DataView(out.buffer);
    out.set([0x52, 0x49, 0x46, 0x46], 0); v.setUint32(4, 36 + n, true);
    out.set([0x57, 0x41, 0x56, 0x45, 0x66, 0x6D, 0x74, 0x20], 8);
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true); v.setUint32(28, 44100, true);
    v.setUint16(32, 1, true); v.setUint16(34, 8, true);
    out.set([0x64, 0x61, 0x74, 0x61], 36); v.setUint32(40, n, true);
    for (let i = 0; i < n; i++) out[44 + i] = Math.floor(i / len) % 2 === 0 ? 0xC0 : 0x40;
    return out;
  }

  it('is absent unless fitted: nothing at $C000/$C100, no deck, no tape files', async () => {
    const m = new Apple1Machine('apple1', null);
    m.memory.writeByte(0xC100, 0x12);
    expect(m.memory.readByte(0xC081)).toBe(0xFF);
    expect(m.memory.readByte(0xC100)).toBe(0xFF);
    expect(m.services.tape).toBeNull();
    expect(m.services.media.accepts().map(t => t.ext)).not.toContain('.wav');
    expect((await m.services.media.mount(square(2, 10), 'tape.wav')).ok).toBe(false);
    expect(m.prepare(view({})).map(r => r.source)).toEqual(['apple2/chargen.rom']);
    m.destroy();
  });

  it('asks for its ROM when fitted, and maps it read-only at $C100', () => {
    const m = withAci();
    expect(m.prepare(view({ 'apple1-aci': true })).map(r => r.source))
      .toEqual(['apple1/aci.rom', 'apple2/chargen.rom']);
    expect(m.memory.readByte(0xC100)).toBe(0xA5);
    expect(m.memory.readByte(0xC1FF)).toBe(0xA5);
    m.memory.writeByte(0xC100, 0x00);
    expect(m.memory.readByte(0xC100)).toBe(0xA5);
    expect(m.memory.readByte(0xC200)).toBe(0xFF);
    m.destroy();
  });

  it('toggles the output on an access with address bit 7 clear, and only counts it', () => {
    const m = withAci();
    m.memory.readByte(0xC000);
    m.memory.writeByte(0xC040, 0);
    expect(m.activity.cassetteToggles).toBe(2);
    m.memory.readByte(0xC081);
    m.memory.peekByte(0xC000);
    expect(m.activity.cassetteToggles).toBe(2);
    m.destroy();
  });

  it('plays a recording into bit 7 of $C081, one flip per zero crossing', async () => {
    const m = withAci();
    const result = await m.services.media.mount(square(20, 22), 'tone.wav');
    expect(result).toMatchObject({ ok: true, target: 'tape' });
    m.services.tape!.play();
    // Count every change of $C081 bit 7: the Monitor-style read loop an ACI program runs.
    m.memory.ram.set([
      0xAD, 0x81, 0xC0, 0x29, 0x80, 0x85, 0x10,   // LDA $C081 / AND #$80 / STA $10
      0xAD, 0x81, 0xC0, 0x29, 0x80, 0xC5, 0x10,   // LOOP: LDA $C081 / AND #$80 / CMP $10
      0xF0, 0xF7,                                 // BEQ LOOP
      0x85, 0x10, 0xE6, 0x11,                     // STA $10 / INC $11
      0x4C, 0x07, 0x03,                           // JMP LOOP
    ], 0x300);
    m.cpu.pc = 0x300;
    for (let i = 0; i < 3; i++) m.tick();
    expect(m.memory.ram[0x11]).toBe(20);
    expect(m.cassette.playing).toBe(false);       // the tape ran out
    m.destroy();
  });

  it('stays still while stopped, and rewinds with a reset', async () => {
    const m = withAci();
    await m.services.media.mount(square(4, 22), 'tone.wav');
    for (let i = 0; i < 2; i++) m.tick();
    expect(m.cassetteInputBit).toBe(false);       // not playing: no crossings delivered
    m.services.tape!.play();
    m.tick();
    expect(m.cassette.finished).toBe(true);
    m.reset();
    expect(m.cassette.finished).toBe(false);
    m.destroy();
  });

  it('exposes the deck and reports it to the frame probe', async () => {
    const m = withAci();
    const tape = m.services.tape!;
    expect(tape.loaded).toBe(false);
    await m.services.media.mount(square(4, 22), 'song.wav');
    expect(tape.loaded).toBe(true);
    expect(tape.name).toBe('song.wav');
    expect(tape.blocks).toHaveLength(1);
    tape.play();
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(out.tapeLoaded).toBe(true);
    expect(out.tapePlaying).toBe(true);
    tape.eject();
    expect(tape.loaded).toBe(false);
    expect((await m.services.media.mount(new Uint8Array(64), 'junk.wav')).ok).toBe(false);
    m.destroy();
  });
});

describe('apple1 terminal', () => {
  it('writes characters, wraps at column 40 and scrolls on the last row', () => {
    const t = new Apple1Terminal();
    for (let i = 0; i < 41; i++) t.put(0xC1);
    expect(t.lines()[0]).toBe('A'.repeat(40));
    expect(t.lines()[1]).toBe('A');
    for (let i = 0; i < 30; i++) t.put(0x8D);
    expect(t.row).toBe(23);
    expect(t.lines().filter(Boolean)).toEqual([]);
  });

  it('shows lower case as capitals and ignores other control codes', () => {
    const t = new Apple1Terminal();
    for (const c of [0x68, 0x07, 0x69]) t.put(c);
    expect(t.lines()[0]).toBe('HI');
  });
});

describe('apple1 keyboard', () => {
  it('encodes upper-case ASCII regardless of the host layout', () => {
    expect(apple1KeyByte(key('KeyA', 'a'))).toBe(0x41);
    expect(apple1KeyByte(key('KeyA', 'A', { shift: true }))).toBe(0x41);
    expect(apple1KeyByte(key('Digit2', '"', { shift: true }))).toBe(0x22);
    expect(apple1KeyByte(key('Enter', 'Enter'))).toBe(0x0D);
    expect(apple1KeyByte(key('Backspace', 'Backspace'))).toBe(0x5F);
    expect(apple1KeyByte(key('KeyC', 'c', { ctrl: true }))).toBe(0x03);
    expect(apple1KeyByte(key('F1', 'F1'))).toBeNull();
    expect(apple1KeyByte(key('Backquote', '{', { shift: true }))).toBeNull();
  });

  it('latches the code with bit 7 set and raises the key-waiting flag', () => {
    const m = new Apple1Machine('apple1', null);
    m.memory.writeByte(0xD011, 0x06);            // positive CA1 edge, data selected
    expect(m.memory.readByte(0xD011) & 0x80).toBe(0);
    expect(m.services.input.keyDown(key('KeyZ', 'z'))).toBe(true);
    expect(m.memory.readByte(0xD011) & 0x80).toBe(0x80);
    expect(m.memory.readByte(0xD010)).toBe(0xDA);
    expect(m.memory.readByte(0xD011) & 0x80).toBe(0);   // reading KBD clears it
    m.destroy();
  });
});

describe('apple1 display handshake', () => {
  it('reads busy on port B bit 7 for one character time after a write', () => {
    const m = new Apple1Machine('apple1', null);
    m.memory.writeByte(0xD012, 0x7F);            // DDRB: bit 7 stays an input
    m.memory.writeByte(0xD013, 0x04);
    expect(m.memory.readByte(0xD012) & 0x80).toBe(0);
    m.memory.writeByte(0xD012, 0xC1);
    expect(m.terminal.lines()[0]).toBe('A');
    expect(m.memory.readByte(0xD012) & 0x80).toBe(0x80);
    m.cpu.tStates += APPLE1_CHAR_CYCLES;
    expect(m.memory.readByte(0xD012) & 0x80).toBe(0);
    m.destroy();
  });
});

describe('apple1 Woz Monitor', () => {
  it('resets into the Monitor and prints its backslash prompt', () => {
    const m = new Apple1Machine('apple1', null);
    m.loadROM(WOZMON);
    m.reset();
    expect(m.cpu.pc).toBe(0xFF00);
    settle(m);
    expect(m.ocrScreenForMcp()).toBe('\\');
    m.destroy();
  });

  it('examines memory: a single address, then a range', () => {
    const m = boot();
    m.memory.writeByte(0x0300, 0xDE);
    m.memory.writeByte(0x0301, 0xAD);
    m.memory.writeByte(0x0302, 0xBE);
    m.memory.writeByte(0x0303, 0xEF);
    typeLine(m, '300\n300.303\n');
    const screen = m.ocrScreenForMcp().split('\n');
    expect(screen).toContain('0300: DE');
    expect(screen).toContain('0300: DE AD BE EF');
    m.destroy();
  });

  it('stores bytes and runs a program from the Monitor', () => {
    const m = boot();
    // LDA #$C8 / JSR ECHO / JMP GETLINE: print 'H' through the Monitor's own ECHO, then
    // hand the terminal back to its prompt.
    typeLine(m, '280: A9 C8 20 EF FF 4C 1F FF\n280.287\n');
    expect(m.ocrScreenForMcp().split('\n')).toContain('0280: A9 C8 20 EF FF 4C 1F FF');
    typeLine(m, '280R\n');
    // The Monitor shows the byte at the run address first, then the program prints its H.
    expect(m.ocrScreenForMcp().split('\n')).toContain('0280: A9H');
    m.destroy();
  });

  it('prints at the terminal pace, 60 characters a second', () => {
    const m = boot();
    // A long examine: 64 bytes is 8 rows of "XXXX: .. .. .. .. .. .. .. ..".
    const start = m.cpu.tStates;
    typeLine(m, '0.3F\n');
    const printed = m.terminal.lines().join('').length;
    expect(printed).toBeGreaterThan(100);
    const seconds = (m.cpu.tStates - start) / m.cpuClockHz;
    expect(seconds).toBeGreaterThan(printed / 61);
    m.destroy();
  });

  it('keeps RAM and the screen on the RESET key but returns to the Monitor', () => {
    const m = boot();
    typeLine(m, '10: 55\n');
    const screen = m.ocrScreenForMcp();
    m.cpu.pc = 0x1234;
    expect(m.pressResetKey()).toBe(true);
    expect(m.cpu.pc).toBe(0xFF00);
    expect(m.memory.readByte(0x0010)).toBe(0x55);
    expect(m.ocrScreenForMcp()).toBe(screen);
    m.destroy();
  });

  it('clears the screen without the CPU', () => {
    const m = boot();
    typeLine(m, 'A');
    expect(m.ocrScreenForMcp()).not.toBe('');
    m.pressClearScreenKey();
    expect(m.ocrScreenForMcp()).toBe('');
    m.destroy();
  });
});

describe('apple1 keys beyond the PIA', () => {
  it('maps Pause to RESET and Home to CLEAR SCREEN', () => {
    const m = boot();
    typeLine(m, '10: 55\n');
    m.cpu.pc = 0x1234;
    expect(m.services.input.keyDown(key('Pause', 'Pause'))).toBe(true);
    expect(m.cpu.pc).toBe(0xFF00);
    expect(m.memory.readByte(0x10)).toBe(0x55);
    expect(m.services.input.keyDown(key('Home', 'Home'))).toBe(true);
    expect(m.ocrScreenForMcp()).toBe('');
    expect(m.keyboard.isHeld('Home')).toBe(true);
    expect(m.services.input.keyUp(key('Home', 'Home'))).toBe(true);
    expect(m.keyboard.isHeld('Home')).toBe(false);
    m.destroy();
  });

  it('encodes on-screen caps by face with SHIFT and CTRL', () => {
    expect(apple1FaceByte('Digit2', false, false)).toBe(0x32);
    expect(apple1FaceByte('Digit2', true, false)).toBe(0x22);
    expect(apple1FaceByte('KeyP', true, false)).toBe(0x40);
    expect(apple1FaceByte('KeyN', true, false)).toBe(0x5E);
    expect(apple1FaceByte('KeyM', true, false)).toBe(0x5D);
    expect(apple1FaceByte('KeyC', false, true)).toBe(0x03);
    expect(apple1FaceByte('colon', true, false)).toBe(0x2A);
    expect(apple1FaceByte('Backspace', false, false)).toBe(0x5F);
    expect(apple1FaceByte('reset', false, false)).toBeNull();
  });

  it('latches an on-screen cap through the same encoder as host keys', () => {
    const m = boot();
    m.keyboard.shiftHeld = true;
    m.keyboard.pressFace('Digit2', true);
    expect(m.pia.portAInput).toBe(0xA2);
    expect(m.keyboard.isHeld('Digit2')).toBe(true);
    m.keyboard.pressFace('Digit2', false);
    expect(m.keyboard.isHeld('Digit2')).toBe(false);
    m.destroy();
  });

  it('lights caps for host keys it does not turn into characters', () => {
    const m = boot();
    expect(m.services.input.keyDown(key('ShiftLeft', 'Shift', { shift: true }))).toBe(false);
    expect(m.keyboard.isHeld('ShiftLeft')).toBe(true);
    m.services.input.keyUp(key('ShiftLeft', 'Shift'));
    expect(m.keyboard.isHeld('ShiftLeft')).toBe(false);
    m.destroy();
  });

  it('places every key of the on-screen keyboard exactly once inside the scene', () => {
    const placed = placeApple1Keys();
    expect(placed).toHaveLength(APPLE1_KEYS.length);
    for (const { box } of placed) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(APPLE1_SCENE.width);
      expect(box.y + box.height).toBeLessThanOrEqual(APPLE1_SCENE.height);
    }
    // Every cap that types a character has an encoding; the rest are RESET, CLEAR and modifiers.
    for (const k of APPLE1_KEYS.filter(k => k.action === 'char')) {
      expect(apple1FaceByte(k.face, false, false), k.id).not.toBeNull();
    }
  });
});

describe('apple1 frame probe', () => {
  it('reports keyboard polling and nothing else', () => {
    const m = boot();
    m.tick();                                    // idle at the prompt: polling KBDCR
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(out.keyboard).toBeGreaterThan(0);
    expect(out.tapeLoaded).toBe(false);
    m.destroy();
  });
});

describe('apple1 display', () => {
  /** Lit pixels in one 7x8 cell. */
  const lit = (m: Apple1Machine, col: number, row: number): number => {
    let n = 0;
    const px = new Uint32Array(m.pixels.buffer);
    for (let y = 0; y < APPLE1_CELL_HEIGHT; y++) {
      for (let x = 0; x < APPLE1_CELL_WIDTH; x++) {
        const at = (APPLE1_BORDER_TOP + row * APPLE1_CELL_HEIGHT + y) * APPLE1_SCREEN_WIDTH
          + APPLE1_BORDER_LEFT + col * APPLE1_CELL_WIDTH + x;
        if (px[at] === 0xFFFFFFFF) n++;
      }
    }
    return n;
  };

  /** A font whose only glyphs are '@' (a solid top row) and 'A' (a solid left column). */
  const font = (): Uint8Array => {
    const rom = new Uint8Array(0x800);
    rom[0x00] = 0x7F;
    for (let row = 0; row < 7; row++) rom[(0x01 << 3) | row] = 0x40;
    return rom;
  };

  /** A booted machine with the test font installed, the way the shell would. */
  function withFont(): Apple1Machine {
    const m = boot();
    const [request] = m.prepare({ get: <T>(_k: string, f: T): T => f });
    request.apply(font());
    return m;
  }

  it('asks for the 2513 character generator shared with the Apple ][', () => {
    const m = new Apple1Machine('apple1', null);
    const [request, ...rest] = m.prepare({ get: <T>(_k: string, f: T): T => f });
    expect(rest).toEqual([]);
    expect(request.source).toBe('apple2/chargen.rom');
    m.destroy();
  });

  it('draws nothing until the font arrives, then redraws what is already on screen', () => {
    const m = boot();
    typeLine(m, 'A');
    for (let i = 0; i < 40; i++) m.tick();
    expect(m.video.pixels.some((v, at) => at % 4 !== 3 && v !== 0)).toBe(false);
    const [request] = m.prepare({ get: <T>(_k: string, f: T): T => f });
    request.apply(font());
    m.tick();
    expect(lit(m, 0, 1)).toBe(7);
    m.destroy();
  });

  it('draws typed characters from the font, one dot per pixel', () => {
    const m = withFont();
    typeLine(m, 'A');
    m.tick();
    expect(m.terminal.lines()[1]).toBe('A');
    expect(lit(m, 0, 1)).toBe(7);                // seven rows of the leftmost dot
    m.destroy();
  });

  it('blinks an @ cursor over the cursor cell', () => {
    const m = withFont();
    typeLine(m, 'A');                            // cursor is now at column 1 of row 1
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) { m.tick(); seen.add(lit(m, 1, 1)); }
    expect([...seen].sort((a, b) => a - b)).toEqual([0, 7]);   // off, and the solid-row @ on
    m.destroy();
  });

  it('keeps the picture until the terminal or cursor changes', () => {
    const m = withFont();
    m.tick();
    const frame = m.video.render(m.terminal, m.charset, true);
    expect(frame).toBe(false);                   // nothing changed since the last frame drew it
    m.destroy();
  });

  it('transcribes the terminal buffer and blanks the cells it covers', () => {
    const m = withFont();
    typeLine(m, 'A');
    m.tick();
    expect(m.services.probe.transcribe).toBeDefined();
    const result = m.ocrScreenStyled();
    expect(result.grid).toBe('40x24');
    expect(result.text.split('\n')[1]).toBe('A'.padEnd(40));
    expect(result.mask[40]).toBe(true);
    expect(result.mask[41]).toBe(false);
    m.blankCells(result.mask);
    expect(lit(m, 0, 1)).toBe(0);
    m.destroy();
  });
});
