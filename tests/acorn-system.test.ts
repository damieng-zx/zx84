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
import { parseSsd } from '@/media/floppy/ssd.ts';
import { deckKeyByte } from '@/machines/acorn-system/ui/keyboard-ascii.ts';
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
      expect(machine.memory.readByte(0x0E21)).toBe(0xFF);
      expect(machine.services.input.keyDown(key('KeyA', 'a'))).toBe(true);
      expect(machine.memory.readByte(0x0E21)).toBe(0x61);
      machine.services.input.keyUp(key('KeyA', 'a'));
      expect(machine.memory.readByte(0x0E21)).toBe(0xFF);
    } finally {
      machine.destroy();
    }
  });

  it('sends CTRL+letter as its control code and RETURN as 0x0D', () => {
    const machine = new AcornSystemMachine('acorn-system2', null);
    try {
      machine.services.input.keyDown(key('KeyC', 'c', { ctrl: true }));
      expect(machine.memory.readByte(0x0E21)).toBe(0x03);
      machine.services.input.keyUp(key('KeyC', 'c', { ctrl: true }));
      machine.services.input.keyDown(key('Enter', 'Enter'));
      expect(machine.memory.readByte(0x0E21)).toBe(0x0D);
    } finally {
      machine.destroy();
    }
  });

  it('puts the same key line on the System 5 card\'s 6522 port A', () => {
    const machine = new AcornSystemMachine('acorn-system5', null);
    try {
      // The 6502A card's VIA answers at &0E20; ORA at +1 is the keyboard.
      expect(machine.memory.readByte(0x0E21)).toBe(0xFF);
      machine.services.input.keyDown(key('KeyB', 'b'));
      expect(machine.memory.readByte(0x0E21)).toBe(0x62);
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

  it('recognises a 2K COS as a System 2 and a 4K DOS as a System 3', () => {
    expect(acornSystemEntry.detectModelForRom!(new Uint8Array(0x800), 'acorn-system2'))
      .toBe('acorn-system2');
    expect(acornSystemEntry.detectModelForRom!(new Uint8Array(0x1000), 'acorn-system2'))
      .toBe('acorn-system3');
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

  it('reports nothing while the BASIC workspace is uninitialised', () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      expect(systemBasicListing(m.memory)).toEqual([]);
      expect(systemBasicVariables(m.memory)).toEqual([]);
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
      // Initialise the text area (PAGE &3000, TOP &3001) as BASIC does at NEW.
      m.memory.writeByte(0x12, 0x30);
      m.memory.writeByte(0x0D, 0x01);
      m.memory.writeByte(0x0E, 0x30);
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
      // Initialise the text area (PAGE &3000, TOP &3001) as BASIC does at NEW.
      m.memory.writeByte(0x12, 0x30);
      m.memory.writeByte(0x0D, 0x01);
      m.memory.writeByte(0x0E, 0x30);
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

/**
 * System 3: the same cards plus the 8271 controller at &0A00 and the DOS/kernel
 * at &F000. The DOS's disc NMI handler reads the data port at +4 ("LDA &0A04"),
 * not +3, and drives a 300-line READ DATA handshake through DRQ.
 */
describe('Acorn System 3 disc controller', () => {
  /** A 40-track single-sided FM disc whose sector 0 holds `first`. */
  function floppy(first: number) {
    const raw = new Uint8Array(2560 * 40);
    raw[0] = first;
    raw[1] = 0x37;
    return parseSsd(raw, false);
  }

  function system3(): AcornSystemMachine {
    return new AcornSystemMachine('acorn-system3', null);
  }

  it('fits the card on a System 3 and not on a System 2', () => {
    const two = new AcornSystemMachine('acorn-system2', null);
    const three = system3();
    try {
      expect(two.disk).toBeNull();
      expect(two.services.disks).toBeNull();
      expect(two.descriptor.ui.builtinDisk).toBe(false);
      // The card's address window reads as the floating bus with it absent.
      expect(two.memory.readByte(0x0A00)).toBe(0x00);

      expect(three.disk).not.toBeNull();
      expect(three.services.disks?.drives.map(d => d.id)).toEqual(['a', 'b']);
      expect(three.descriptor.ui.builtinDisk).toBe(true);
    } finally {
      two.destroy();
      three.destroy();
    }
  });

  it('reads a sector through the card at &0A00-&0A04', () => {
    const m = system3();
    try {
      m.reset();
      m.disk!.insertDisk(floppy(0x42), 0);

      // READ DATA: command, then track, sector, count as parameters.
      m.memory.writeByte(0x0A00, 0x12);
      m.memory.writeByte(0x0A01, 0x00);
      m.memory.writeByte(0x0A01, 0x00);
      m.memory.writeByte(0x0A01, 0x01);
      // Status: busy while the transfer runs.
      expect(m.memory.readByte(0x0A00) & 0x80).toBe(0x80);

      const bytes: number[] = [];
      for (let i = 0; i < 256; i++) {
        m.disk!.tick(80);                        // a data request apiece
        bytes.push(m.memory.readByte(0x0A04));
      }
      expect(bytes[0]).toBe(0x42);
      expect(bytes[1]).toBe(0x37);
      expect(bytes[2]).toBe(0x00);

      m.disk!.tick(80);                          // end of transfer
      m.disk!.tick(60);                          // result settles
      expect(m.memory.readByte(0x0A00) & 0x80).toBe(0x00);   // no longer busy
      expect(m.memory.readByte(0x0A01)).toBe(0x00);          // completed, no error
    } finally {
      m.destroy();
    }
  });

  it('mounts a .ssd into a drive and writes it back out', async () => {
    const m = system3();
    try {
      const raw = new Uint8Array(2560 * 40);
      const mounted = await m.services.media.mount(raw, 'blank.ssd');
      expect(mounted).toMatchObject({ ok: true, target: 'a' });
      expect(m.services.disks!.drives[0]).toMatchObject({ loaded: true, mediaName: 'blank.ssd' });
      const saved = m.services.disks!.save('a');
      expect(saved?.name).toBe('blank.ssd');
      expect(saved?.data.length).toBe(raw.length);
    } finally {
      m.destroy();
    }
  });

  it('refuses a disc when no controller is fitted', async () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      const mounted = await m.services.media.mount(new Uint8Array(2560 * 40), 'x.ssd');
      expect(mounted.ok).toBe(false);
    } finally {
      m.destroy();
    }
  });
});

/**
 * The on-screen deck is the Atom's ASCII keyboard (`ui/keyboard/AcornDeck.tsx`),
 * but a System keyboard is an encoder: each cap puts one ASCII code on the port.
 */
describe('Acorn System on-screen keyboard', () => {
  const cap = (main: string, shift?: string) => ({ main, shift, action: 'key' as const });

  it('sends the shifted glyph for a two-legend cap', () => {
    expect(deckKeyByte(cap('1', '!'), false, false)).toBe(0x31);
    expect(deckKeyByte(cap('1', '!'), true, false)).toBe(0x21);
  });

  it('takes the code the system software gives the caps with no ASCII', () => {
    expect(deckKeyByte(cap('RETURN'), false, false)).toBe(0x0d);
    expect(deckKeyByte(cap('DELETE'), false, false)).toBe(0x7f);
    // COPY is the DOS's copy key, Ctrl-Q; the arrows are its cursor moves.
    expect(deckKeyByte(cap('COPY'), false, false)).toBe(0x11);
    expect(deckKeyByte(cap('↔'), false, false)).toBe(0x01);
    expect(deckKeyByte(cap('↑'), false, false)).toBe(0x17);
  });

  it('makes CTRL+letter a control code and LOCK lower case', () => {
    expect(deckKeyByte(cap('C'), false, true)).toBe(0x03);
    expect(deckKeyByte(cap('A'), false, false)).toBe(0x41);
    expect(deckKeyByte(cap('A'), false, false, true)).toBe(0x61);
  });

  it('has no code for a modifier or the case lock', () => {
    expect(deckKeyByte({ main: 'SHIFT', action: 'shift' }, false, false)).toBeNull();
    expect(deckKeyByte(cap('LOCK'), false, false)).toBeNull();
  });

  it('puts a tapped cap on the keyboard port and clears it on release', () => {
    const m = new AcornSystemMachine('acorn-system2', null);
    try {
      m.pressKey(0x41);
      expect(m.memory.readByte(0x0E21)).toBe(0x41);
      m.releaseKey();
      expect(m.memory.readByte(0x0E21)).toBe(0xFF);
    } finally {
      m.destroy();
    }
  });
});

describe('Acorn System 5', () => {
  it('fits the 6502A card, the 80x25 VDU and 48K of dynamic RAM', () => {
    const m = new AcornSystemMachine('acorn-system5', null);
    try {
      expect(m.cpuClockHz).toBe(2_000_000);
      // 312 lines of 128 cycles at 2 MHz.
      expect(m.tStatesPerFrame).toBe(39_936);
      // 80 columns of 8 dots by 25 rows of 10 lines, inside the border.
      expect(m.descriptor.screen.activeWidth).toBe(640);
      expect(m.descriptor.screen.activeHeight).toBe(250);
      expect(m.frameWidth).toBe(672);
      expect(m.frameHeight).toBe(266);
      expect(m.descriptor.ui.colorMap).toBe('mono');
      expect(m.descriptor.ui.builtinDisk).toBe(true);
      // 32K at &2000 plus 16K at &A000.
      expect(m.memory.ramBankCount).toBe(12);
      m.memory.writeByte(0x2000, 0x11);
      m.memory.writeByte(0xDFFF, 0x22);
      expect(m.memory.peekByte(0x2000)).toBe(0x11);
      expect(m.memory.peekByte(0xDFFF)).toBe(0x22);
      expect(m.memory.peekByte(0xE000)).toBe(0x00);
      // The 80x25 card's windows: screen RAM at &1000, CRTC at &1840.
      m.memory.writeByte(0x1000, 0x41);
      expect(m.memory.peekByte(0x1000)).toBe(0x41);
      m.memory.writeByte(0x1840, 0x0C);          // select R12
      m.memory.writeByte(0x1841, 0x30);          // screen base &3000 (MA)
      expect(m.crtc.displayStart).toBe(0x3000);
    } finally {
      m.destroy();
    }
  });

  it('draws the character-generator glyphs at a 16-byte stride', () => {
    const m = new AcornSystemMachine('acorn-system5', null);
    try {
      // The card's ROM is 128 glyphs of 16 bytes: ten rows of cell, then six
      // unused. 'A' lives at &41 * 16, not at &41 * 8 — indexing at eight bytes
      // lands in the middle of a neighbouring block and draws the wrong glyph.
      const font = new Uint8Array(2048);
      font[0x41 * 16] = 0xFF;                     // glyph 'A', first row all dots
      m.loadFont(font);
      // Cell 1: cell 0 carries the power-on cursor, which paints its whole cell.
      m.memory.writeByte(0x1001, 0x41);
      m.tick();
      const px = new Uint32Array(m.pixels.buffer);
      // Glyph row 0 of cell 1 is the first scanline of the top character row.
      const y = 8;
      const x = 16 + 8;
      expect(px[y * 672 + x]).toBe(0xFFFFFFFF);
    } finally {
      m.destroy();
    }
  });

  it('draws a descender from the glyph block\'s ninth and tenth rows', () => {
    const m = new AcornSystemMachine('acorn-system5', null);
    try {
      // 'g' at &67 * 16: body in rows 0-7, its tail in rows 8-9. Drawing only
      // the first eight rows drops the descender.
      const font = new Uint8Array(2048);
      font[0x67 * 16 + 8] = 0xF0;                 // descender row of 'g'
      m.loadFont(font);
      m.memory.writeByte(0x1001, 0x67);
      m.tick();
      const px = new Uint32Array(m.pixels.buffer);
      // Cell row 0 starts at y=8, so the ninth glyph row is y=16.
      expect(px[16 * 672 + 16 + 8]).toBe(0xFFFFFFFF);
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
