/**
 * JupiterAceMachine — ULA port behaviour, video rendering and the service
 * surface. Expected pixel/port values are derived from the Ace hardware
 * (MAME cantab/jupace.cpp): even ports decode as the ULA, EAR is bit 5,
 * and the screen file is a linear 32×24 char-code table with bit 7 inverse.
 */

import { describe, it, expect } from 'vitest';
import type { TapeBlock } from '@/media/tape/tap.ts';
import { createFrameIndicators } from '@/machines/machine.ts';
import { JupiterAceMachine } from '@/machines/jupiter-ace/ace-machine.ts';
import { ACE_T_PER_FRAME, ACE_CPU_CLOCK } from '@/machines/jupiter-ace/constants.ts';

function machine(): JupiterAceMachine {
  const m = new JupiterAceMachine('jupiter-ace', null);
  m.start = async () => {};   // headless: no AudioContext / rAF
  return m;
}

describe('JupiterAceMachine — construction', () => {
  it('exposes Ace geometry, clock and a deck-backed tape with no disk/snapshot', () => {
    const m = machine();
    expect(m.kind).toBe('jupiter-ace');
    expect(m.tStatesPerFrame).toBe(65_000);
    expect(m.cpuClockHz).toBe(3_250_000);
    expect(m.frameWidth).toBe(320);
    expect(m.frameHeight).toBe(240);
    expect(m.services.tape).not.toBeNull();
    expect(m.services.disks).toBeNull();
    expect(m.services.snapshots).toBeNull();
    expect(m.services.roms.cartridge).toBeNull();
    // The deck plays 3.5MHz-referenced pulses on a 3.25MHz CPU.
    expect(m.tape.pulseScale).toBeCloseTo(ACE_CPU_CLOCK / 3_500_000, 10);
    m.destroy();
  });

  it('descriptor: monochrome 320×240 text screen, deck tape, honest capability flags', () => {
    const m = machine();
    const d = m.descriptor;
    expect(d.cpuFamily).toBe('z80');
    expect(d.screen).toEqual({
      width: 320, height: 240, pixelAspectX: 1,
      activeWidth: 256, activeHeight: 192,
      borderLeft: 32, borderTop: 24,
    });
    expect(d.ui.tape).toBe('deck');
    expect(d.ui.beeper).toBe(true);
    expect(d.ui.mouseTypes).toEqual([]);
    expect(d.ui.statusLeds).toEqual(['kbd', 'ear', 'load', 'beep']);
    m.destroy();
  });
});

describe('JupiterAceMachine — ULA port 0xFE', () => {
  it('an idle keyboard read returns 0xFF (rows 0x1F + floating bits 5-7 high)', () => {
    const m = machine();
    expect(m.cpu.portInHandler!(0xFEFE)).toBe(0xFF);
    m.destroy();
  });

  it('a pressed key pulls its bit low, other bits float high', () => {
    const m = machine();
    m.keyboard.handleKeyEvent('KeyZ', true);
    // Row 0 bit 2 low: 0xFB | 0xC0 | (idle EAR → 0x20) = 0xFB.
    expect(m.cpu.portInHandler!(0xFEFE)).toBe(0xFB);
    m.destroy();
  });

  it('an EAR-only read (high byte 0xFF) selects no keyboard row', () => {
    const m = machine();
    m.keyboard.handleKeyEvent('KeyZ', true);
    expect(m.cpu.portInHandler!(0xFFFE)).toBe(0xFF);
    m.destroy();
  });

  it('odd ports read open bus (0xFF)', () => {
    const m = machine();
    expect(m.cpu.portInHandler!(0x0001)).toBe(0xFF);
    expect(m.cpu.portInHandler!(0x00FF)).toBe(0xFF);
    m.destroy();
  });

  it('OUT bit 4 drives the buzzer, bit 3 the MIC/save output', () => {
    const m = machine();
    m.cpu.portOutHandler!(0xFE, 0x10);
    expect(m.ula.buzzerBit).toBe(1);
    expect(m.ula.micBit).toBe(0);
    m.cpu.portOutHandler!(0xFE, 0x08);
    expect(m.ula.buzzerBit).toBe(0);
    expect(m.ula.micBit).toBe(1);
    m.destroy();
  });
});

describe('JupiterAceMachine — video', () => {
  it('renders the glyph of the screen-file char code, ink on paper', () => {
    const m = machine();
    // Cell (0,0): char code 65, glyph row 0 = 0xFF (all ink).
    m.memory.getVram()[0] = 65;
    m.memory.getCharRam()[65 * 8 + 0] = 0xFF;
    m.tick();
    const px = m.pixels;
    // Active area origin = (borderLeft=32, borderTop=24); glyph row 0 covers
    // screen scanline 24, first ink pixel at x = 32.
    const ink = (24 * 320 + 32) * 4;
    expect(px[ink + 3]).toBe(255);   // opaque
    expect(px[ink]).toBe(0);         // black ink
    // Paper: the pixel right after the cell (x = 40) stays white.
    const paper = (24 * 320 + 40) * 4;
    expect(px[paper]).toBe(255);
    // Glyph rows 1-7 are 0x00 → paper inside the cell below the first line.
    const below = (25 * 320 + 32) * 4;
    expect(px[below]).toBe(255);
    m.destroy();
  });

  it('char code bit 7 renders the glyph inverted', () => {
    const m = machine();
    m.memory.getVram()[1] = 65 | 0x80;
    m.memory.getCharRam()[65 * 8 + 0] = 0xFF;
    m.tick();
    const px = m.pixels;
    // Inverted: glyph 0xFF becomes 0x00 → the whole cell renders paper.
    const x = (24 * 320 + 40) * 4;   // cell (0,1) starts at x = 40
    expect(px[x]).toBe(255);
    expect(px[x + 1]).toBe(255);
    m.destroy();
  });

  it('the border is paper-white outside the active area', () => {
    const m = machine();
    m.tick();
    const px = m.pixels;
    expect(px[0]).toBe(255);                       // top-left corner
    expect(px[(10 * 320 + 10) * 4]).toBe(255);     // border, above active area
    m.destroy();
  });

  it('burns one frame budget of T-states per tick', () => {
    const m = machine();
    const before = m.cpu.tStates;
    m.tick();
    expect(m.cpu.tStates).toBeGreaterThanOrEqual(before + ACE_T_PER_FRAME);
    m.destroy();
  });
});

describe('JupiterAceMachine — frame probe', () => {
  it('reports tape transport and activity without allocating', () => {
    const m = machine();
    m.cpu.portOutHandler!(0xFE, 0x10);  // buzzer toggle recorded in this frame's activity
    const out = {
      keyboard: -1, joystick: -1, mouse: -1, tapeIn: -1, tapeLoad: -1,
      beeper: -1, psg: -1, videoFx: -1, disk: -1,
      tapeTurbo: true, tapeLoaded: false, tapePlaying: false, tapePaused: false,
      tapeFinished: false, tapePosition: -1, casBlock: 0, fastRomLoading: true,
      tracingActive: true,
      driveLed: new Int8Array(4).fill(0),
      driveTrack: new Int16Array(4),
      driveSector: new Int16Array(4).fill(0),
      driveDirty: new Uint8Array(4),
      formattedSlot: 0, scanUnsupported: 0,
      mdvMotorMask: -1, mdvCount: -1, mdvSector: new Int16Array(8),
      floppySlot: 0, floppyMotor: true, floppyTrack: 0, floppyProfile: 0,
    };
    m.services.probe.sample(out);
    expect(out.beeper).toBe(1);        // buzzer toggled this frame
    expect(out.tapeLoaded).toBe(false);
    expect(out.tapePlaying).toBe(false);
    // Fresh deck: `paused` is only set by a mount — nothing is mounted here.
    expect(out.tapePaused).toBe(false);
    expect(out.driveLed[0]).toBe(-1);  // no drives: slot absent
    expect(out.floppySlot).toBe(-1);
    expect(out.casBlock).toBe(-1);
    m.destroy();
  });
});

describe('JupiterAceMachine — RAM pack option', () => {
  function viewOf(value: string | undefined): { get<T>(_k: string, fallback: T): T } {
    return { get<T>(_k: string, fallback: T): T { return (value as T) ?? fallback; } };
  }

  it('prepare() defaults to the official 48K RAM pack (51K total)', () => {
    const m = machine();
    m.prepare!(viewOf(undefined));
    expect(m.memory.ramPackKB).toBe(48);
    m.memory.writeByte(0xFFFF, 0x42);
    expect(m.memory.readByte(0xFFFF)).toBe(0x42);
    m.destroy();
  });

  it("prepare() maps the 16K pack's 0x4000-0x7FFF window", () => {
    const m = machine();
    m.prepare!(viewOf('16k'));
    expect(m.memory.ramPackKB).toBe(16);
    m.memory.writeByte(0x7FFF, 0x42);
    expect(m.memory.readByte(0x7FFF)).toBe(0x42);
    m.memory.writeByte(0x8000, 0x42);
    expect(m.memory.readByte(0x8000)).toBe(0xFF);
    m.destroy();
  });

  it("prepare() leaves a 'none' machine at stock 3K", () => {
    const m = machine();
    m.prepare!(viewOf('none'));
    expect(m.memory.ramPackKB).toBe(0);
    m.memory.writeByte(0x4000, 0x42);
    expect(m.memory.readByte(0x4000)).toBe(0xFF);
    m.destroy();
  });

  it('the RAM dump grows with the fitted pack', () => {
    const m = machine();
    m.prepare!(viewOf('48k'));
    expect(m.ramExportBytes().data.length).toBe(0xC00 + 0xC000);
    m.destroy();
  });
});

describe('JupiterAceMachine — tape turbo', () => {
  /** A minimal deck block so `tape.loaded` is true and advance() has work. */
  function deckBlock(): TapeBlock {
    return {
      kind: 'data', flag: 0xFF, data: new Uint8Array(64),
      pause: 1000, pilotPulse: 2168, syncPulse1: 667, syncPulse2: 735,
      bit0Pulse: 855, bit1Pulse: 1710, pilotCount: 3223, usedBits: 8, source: 'tap',
    };
  }

  it('stays paced when no tape is loading', () => {
    const m = machine();
    m.tick();
    expect(m.tapeTurboActive).toBe(false);
    m.destroy();
  });

  it('engages turbo while the loader consumes the tape, and the probe reports it', () => {
    const m = machine();
    m.tape.blocks = [deckBlock()];
    m.tape.playing = true;
    m.tape.paused = false;
    m.loaderDetector.loaderActive = true;  // the ROM is polling the EAR
    m.tick();
    expect(m.tapeTurboActive).toBe(true);
    const out = createFrameIndicators();
    m.services.probe.sample(out);
    expect(out.tapeTurbo).toBe(true);
    m.destroy();
  });

  it('a user stop overrides turbo even while the loader polls', () => {
    const m = machine();
    m.tape.blocks = [deckBlock()];
    m.loaderDetector.loaderActive = true;
    m.loaderDetector.userOverride = true;  // user pressed stop
    m.tick();
    expect(m.tapeTurboActive).toBe(false);
    m.destroy();
  });

  it('reset clears the turbo state', () => {
    const m = machine();
    m.tape.blocks = [deckBlock()];
    m.tape.playing = true;
    m.loaderDetector.loaderActive = true;
    m.tick();
    expect(m.tapeTurboActive).toBe(true);
    m.reset();
    expect(m.tapeTurboActive).toBe(false);
    m.destroy();
  });
});

describe('JupiterAceMachine — debug surface', () => {
  it('reads the screen file back as text via the MCP ocr hook', () => {
    const m = machine();
    const vram = m.memory.getVram();
    const hello = 'OK';
    for (let i = 0; i < hello.length; i++) vram[i] = hello.charCodeAt(i);
    const text = m.ocrScreenForMcp();
    expect(text.split('\n')[0]).toBe(hello);
    m.destroy();
  });

  it('exposes memory regions for the Memory pane', () => {
    const m = machine();
    expect(m.resolveMemoryRegion('vram')).toEqual({ data: m.memory.getVram(), baseAddr: 0x2400 });
    expect(m.resolveMemoryRegion('nonsense')).toBeNull();
    m.destroy();
  });
});
