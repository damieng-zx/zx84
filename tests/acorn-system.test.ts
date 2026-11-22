/**
 * Acorn System 2.
 *
 * The 8154 assertions are derived from the part's documented map (registers
 * below A7, mirrored on A0/A1; the 128-byte RAM above it) and from the Acorn
 * System 1 monitor's own use of the chip (`X1PIA`/`X1PIB` at +0x20/+0x21,
 * `X1ADDR`/`X1BDDR` at +0x22/+0x23, RAM at +0x80). The boot test drives a
 * hand-written 2K ROM so it does not depend on a downloaded image.
 */

import { describe, expect, it } from 'vitest';
import { Ins8154 } from '@/cores/ins8154.ts';
import { AcornSystemMachine } from '@/machines/acorn-system/machine.ts';
import { systemBasicListing, systemBasicVariables } from '@/machines/acorn-system/basic.ts';
import { acornSystemEntry } from '@/machines/acorn-system/descriptor.ts';
import { buildUef, type UefChunk } from '@/media/tape/uef.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const chunk = (id: number, ...data: number[]): UefChunk => ({ id, data: Uint8Array.from(data) });

function key(code: string, k: string, mods: Partial<HostKeyEvent> = {}): HostKeyEvent {
  return { code, key: k, shift: false, ctrl: false, alt: false, ...mods };
}

/**
 * A 2K ROM at &F800 that writes "ACORN SYSTEM 2" into the character RAM at
 * &0400 and then spins, so the VDU path can be checked without a real COS.
 */
function testRom(): Uint8Array {
  const rom = new Uint8Array(0x800);
  const code = [
    0xA2, 0x00,        // LDX #$00
    0xBD, 0x20, 0xF8,  // LDA $F820,X
    0xF0, 0xFE,        // BEQ *        (message ended: spin)
    0x9D, 0x00, 0x04,  // STA $0400,X
    0xE8,              // INX
    0x4C, 0x02, 0xF8,  // JMP $F802
  ];
  rom.set(code, 0);
  const message = 'ACORN SYSTEM 2';
  for (let i = 0; i < message.length; i++) rom[0x20 + i] = message.charCodeAt(i);
  rom[0x20 + message.length] = 0;
  // RESET vector at $FFFC (offset $7FC): &F800.
  rom[0x7FC] = 0x00;
  rom[0x7FD] = 0xF8;
  return rom;
}

describe('INS8154', () => {
  it('puts the 128-byte RAM above A7 and the four registers below it', () => {
    const pia = new Ins8154();
    pia.write(0x80, 0x5A);
    pia.write(0xFF, 0xA5);
    expect(pia.read(0x80)).toBe(0x5A);
    expect(pia.read(0xFF)).toBe(0xA5);
    // Different cells: the RAM is not mirrored.
    expect(pia.read(0x00)).not.toBe(0x5A);
  });

  it('mirrors the registers on A0/A1 only, so +0x20 and +0x24 are the same register', () => {
    const pia = new Ins8154();
    pia.write(0x22, 0xFF);                 // port A direction = all outputs
    expect(pia.read(0x26)).toBe(0xFF);
    expect(pia.read(0x3A)).toBe(0xFF);
    // A2..A6 do not reach the register select.
    pia.write(0x24, 0x12);                 // same register as +0x20 (port A data)
    expect(pia.read(0x20)).toBe(0x12);
  });

  it('reads the latch on output pins and the board level on input pins', () => {
    const pia = new Ins8154();
    pia.write(0x22, 0xF0);                 // port A high nibble out, low nibble in
    pia.write(0x20, 0xAA);                 // latch
    pia.portAInput = 0x55;                 // world drives the low nibble
    expect(pia.read(0x20)).toBe(0xA5);
  });

  it('returns the direction registers at +0x22 and +0x23', () => {
    const pia = new Ins8154();
    pia.write(0x22, 0x0F);
    pia.write(0x23, 0xF0);
    expect(pia.read(0x22)).toBe(0x0F);
    expect(pia.read(0x23)).toBe(0xF0);
  });

  it('boots a ROM from &F800 and shows what it writes to the character RAM', () => {
    const machine = new AcornSystemMachine('acorn-system2', null);
    try {
      machine.loadROM(testRom());
      machine.reset();
      machine.runUntil(5);
      expect(machine.ocrScreenForMcp()).toBe('ACORN SYSTEM 2');
      // The picture is not blank: white glyph dots on black.
      const pixels32 = new Uint32Array(machine.pixels.buffer);
      expect(pixels32.some(p => p === 0xFFFFFFFF)).toBe(true);
      expect(pixels32.every(p => p === 0xFF000000)).toBe(false);
    } finally {
      machine.destroy();
    }
  });

  it('places a 4K image at &F000 instead of &F800', () => {
    const machine = new AcornSystemMachine('acorn-system2', null);
    try {
      const rom = new Uint8Array(0x1000);
      rom[0] = 0x42;
      rom[0x800] = 0x37;
      machine.loadROM(rom);
      expect(machine.memory.peekByte(0xF000)).toBe(0x42);
      expect(machine.memory.peekByte(0xF800)).toBe(0x37);
    } finally {
      machine.destroy();
    }
  });
});

describe('Acorn System 2 keyboard', () => {
  it('holds the ASCII code on port B with bit 7 low while a key is down', () => {
    const machine = new AcornSystemMachine('acorn-system2', null);
    try {
      expect(machine.pia.portBInput).toBe(0xFF);
      expect(machine.services.input.keyDown(key('KeyA', 'a'))).toBe(true);
      expect(machine.pia.portBInput).toBe(0x61);
      machine.services.input.keyUp(key('KeyA', 'a'));
      expect(machine.pia.portBInput).toBe(0xFF);
    } finally {
      machine.destroy();
    }
  });

  it('sends CTRL+letter as its control code and RETURN as 0x0D', () => {
    const machine = new AcornSystemMachine('acorn-system2', null);
    try {
      machine.services.input.keyDown(key('KeyC', 'c', { ctrl: true }));
      expect(machine.pia.portBInput).toBe(0x03);
      machine.services.input.keyUp(key('KeyC', 'c', { ctrl: true }));
      machine.services.input.keyDown(key('Enter', 'Enter'));
      expect(machine.pia.portBInput).toBe(0x0D);
    } finally {
      machine.destroy();
    }
  });

  it('counts keyboard-port polling for the KEY indicator', () => {
    const machine = new AcornSystemMachine('acorn-system2', null);
    try {
      machine.memory.readByte(0x0E21);
      machine.memory.readByte(0x0E21);
      expect(machine.activity.kbdReads).toBe(2);
      // A read of the port A data register is the cassette, not the keyboard.
      machine.memory.readByte(0x0E20);
      expect(machine.activity.kbdReads).toBe(2);
    } finally {
      machine.destroy();
    }
  });
});

describe('Acorn System 2 registry entry', () => {
  it('fetches the 2K COS/kernel as the system ROM', () => {
    expect(acornSystemEntry.romSources('acorn-system2')).toEqual(['acorn-system/syscos40.rom']);
  });

  it('recognises a 2K COS or a 4K DOS by shape', () => {
    expect(acornSystemEntry.detectModelForRom!(new Uint8Array(0x800), 'acorn-system2'))
      .toBe('acorn-system2');
    expect(acornSystemEntry.detectModelForRom!(new Uint8Array(0x1000), 'acorn-system2'))
      .toBe('acorn-system2');
    expect(acornSystemEntry.detectModelForRom!(new Uint8Array(0x400), 'acorn-system2'))
      .toBeNull();
  });
});

/**
 * The stored program is plain text, not tokens: each line is
 * [number high][number low][source…]&0D, and the area ends with &FF ("TOP points
 * past it" — BASIC.ca65's LIST walks the bytes until the CR).
 */
describe('System BASIC program listing', () => {
  function programmer(): AcornSystemMachine {
    const m = new AcornSystemMachine('acorn-system2', null);
    m.loadBasic(new Uint8Array(0x1000));
    return m;
  }

  function writeTextArea(m: AcornSystemMachine, lines: readonly (readonly [number, string])[], terminator = true): void {
    m.memory.writeByte(0x12, 0x30);            // BOTTOM page
    let p = 0x3000;
    m.memory.writeByte(p++, 0x0D);             // the empty line a NEW leaves
    for (const [number, text] of lines) {
      m.memory.writeByte(p++, number >> 8);
      m.memory.writeByte(p++, number & 0xFF);
      for (const ch of text) m.memory.writeByte(p++, ch.charCodeAt(0));
      m.memory.writeByte(p++, 0x0D);
    }
    if (terminator) m.memory.writeByte(p++, 0xFF);
    m.memory.writeByte(0x0D, p & 0xFF);
    m.memory.writeByte(0x0E, p >> 8);
  }

  it('decodes line numbers, text and the trailing marker', () => {
    const m = programmer();
    try {
      writeTextArea(m, [[10, ' A=42'], [20, ' GOTO 10']]);
      expect(systemBasicListing(m.memory)).toEqual([
        { lineNumber: 10, text: 'A=42' },
        { lineNumber: 20, text: 'GOTO 10' },
      ]);
    } finally {
      m.destroy();
    }
  });

  it('reports nothing when BASIC is not fitted', () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      writeTextArea(m, [[10, ' A=1']]);
      expect(systemBasicListing(m.memory)).toEqual([]);
    } finally {
      m.destroy();
    }
  });

  it('refuses a text area holding a non-printable byte', () => {
    const m = programmer();
    try {
      writeTextArea(m, [[10, ' A=1']]);
      m.memory.writeByte(0x3004, 0x01);
      expect(systemBasicListing(m.memory)).toEqual([]);
    } finally {
      m.destroy();
    }
  });
});

/** Integer variables are four parallel pages from &0322; FOR stacks from &0240. */
describe('System BASIC variables', () => {
  it('reads a signed 32-bit integer per letter', () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      m.loadBasic(new Uint8Array(0x1000));
      // A = 42
      m.memory.writeByte(0x0322, 42);
      // B = -1 (all four bytes set)
      for (const base of [0x0322, 0x033D, 0x0358, 0x0373]) m.memory.writeByte(base + 1, 0xFF);
      const vars = systemBasicVariables(m.memory);
      expect(vars).toHaveLength(26);
      expect(vars[0]).toEqual({ name: 'A', kind: 'number', value: '42' });
      expect(vars[1]).toEqual({ name: 'B', kind: 'number', value: '-1' });
      expect(vars[25]).toEqual({ name: 'Z', kind: 'number', value: '0' });
    } finally {
      m.destroy();
    }
  });

  it('lists a live FOR loop with its TO and STEP instead of a bare number', () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      m.loadBasic(new Uint8Array(0x1000));
      m.memory.writeByte(0x15, 1);              // forcnt = 1
      m.memory.writeByte(0x0240, 9);            // FOR variable I (9th letter)
      m.memory.writeByte(0x0322 + 8, 2);        // I = 2
      m.memory.writeByte(0x024F, 1);            // STEP = 1
      m.memory.writeByte(0x028B, 3);            // TO = 3
      const vars = systemBasicVariables(m.memory);
      expect(vars[0]).toEqual({
        name: 'I', kind: 'for-next', value: '2', detail: 'TO 3 STEP 1',
      });
      expect(vars.some(v => v.name === 'I' && v.kind === 'number')).toBe(false);
      expect(vars).toHaveLength(26);            // the loop replaces, not adds
    } finally {
      m.destroy();
    }
  });
});

describe('Acorn System 2 transcription', () => {
  it('reads the character RAM with the SAA5050 colours', () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      // Red alpha, then "X": cell 0 is the control byte, cell 1 the red X.
      m.memory.writeByte(0x0400, 0x01);
      m.memory.writeByte(0x0401, 0x58);
      const r = m.ocrScreenStyled();
      expect(r.grid).toBe('40x25');
      expect(r.cellWidth).toBe(12);
      expect(r.cellHeight).toBe(10);
      expect(r.text.split('\n')[0].trimEnd()).toBe(' X');
      expect(r.mask[0]).toBe(false);            // a control byte is not text
      expect(r.mask[1]).toBe(true);
      expect(r.html).toContain('#ff5555');      // SAA5050 red
    } finally {
      m.destroy();
    }
  });
});

/**
 * The CUTS cassette: 300 baud 8N1 on the CPU card's 8154 — bit 7 in (the
 * demodulated data line) and bit 6 out. The computer has no motor relay, so the
 * transport is live and the Tape pane moves the tape.
 */
describe('Acorn System 2 cassette', () => {
  it('mounts a UEF and puts the demodulated bits on port A bit 7', async () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      m.reset();
      const data = Array.from({ length: 120 }, (_, i) => (i & 1 ? 0xAA : 0x55));
      const uef = buildUef([chunk(0x0110, 0xB0, 0x04), chunk(0x0100, ...data)]);
      const result = await m.services.media.mount(uef, 'test.uef');
      expect(result).toMatchObject({ ok: true, target: 'tape' });
      expect(m.services.tape.loaded).toBe(true);
      const levels = new Set<number>();
      for (let f = 0; f < 250; f++) {
        m.memory.readByte(0x0E20);              // refresh the port's input pins
        levels.add((m.pia.portAInput >> 7) & 1);
        m.tick();
      }
      expect([...levels].sort()).toEqual([0, 1]);
    } finally {
      m.destroy();
    }
  });
});
