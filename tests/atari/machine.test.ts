/**
 * Atari 400/800 integration tests: registration, model geometry, a boot of a
 * synthetic 10K OS (write COLBK, loop), the region clock, RAM size and the
 * services the generic panes bind to.
 *
 * The synthetic ROM is deliberately not the real Atari OS: it proves the
 * memory map, reset vector, 6502 wiring and GTIA store path without depending
 * on firmware that is not in the tree.
 */

import { describe, it, expect, vi } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { atariEntry } from '@/machines/atari/descriptor.ts';
import {
  ATARI_OS_SIZE, atariRegionForLocale, type AtariModel, type AtariRegion,
} from '@/machines/atari/models.ts';
import type { SettingsView } from '@/machines/machine.ts';

function makeOs(): Uint8Array {
  const rom = new Uint8Array(ATARI_OS_SIZE);
  // $E000: LDA #$1E ; STA COLBK ($D01A) ; JMP $E000
  rom.set([0xa9, 0x1e, 0x8d, 0x1a, 0xd0, 0x4c, 0x00, 0xe0], 0x800);
  // Reset vector at $FFFC -> $E000.
  rom[0x27fc] = 0x00;
  rom[0x27fd] = 0xe0;
  return rom;
}

function boot(model: AtariModel = 'atari800', region: AtariRegion = 'ntsc'): AtariMachine {
  const m = new AtariMachine(model, null, region);
  m.services.roms.installSystemRom(makeOs());
  m.reset();
  return m;
}

describe('atari registration', () => {
  it('is registered as an m6502 machine with one model per machine', () => {
    expect(atariEntry.models).toEqual([
      'atari400', 'atari800', 'atari600xl', 'atari800xl', 'atari1200xl',
      'atari65xe', 'atari800xe', 'atari130xe',
    ]);
    const m = boot();
    try {
      expect(m.kind).toBe('atari');
      expect(m.descriptor.cpuFamily).toBe('m6502');
      expect(m.services.debug.ports).toBeNull();
      expect(m.services.debug.cpuFamily).toBe('m6502');
    } finally {
      m.destroy();
    }
  });

  it('declares the Atari hardware capabilities honestly', () => {
    const ui = atariEntry.descriptor('atari800').ui;
    expect(ui.cartridge).toBe(true);
    expect(ui.bootCartridge).toBe(true);
    expect(ui.joystick).toBe(true);
    expect(ui.builtinDisk).toBe(true);
    expect(ui.builtinDrives).toBe(4);
    expect(ui.builtinDriveLabels).toEqual(['D1:', 'D2:', 'D3:', 'D4:']);
    expect(ui.driveModels?.map(m => m.value)).toEqual(['810', '1050', 'xf551', 'sio2pc']);
    expect(ui.defaultDriveModels).toEqual(['sio2pc', 'sio2pc']);
    expect(ui.tape).toBe('instant');
    expect(ui.tapeExtensions).toContain('.cas');
    expect(ui.fixedJoystick).toBe(true);
    expect(ui.joystickFireButtons).toBe(1);
    expect(ui.colorMap).toBe('atari');
  });
});

describe('atari model geometry and timing', () => {
  it('reports NTSC timing for an NTSC machine', () => {
    const m = boot('atari800', 'ntsc');
    try {
      expect(m.cpuClockHz).toBe(1_789_772);
      expect(m.tStatesPerFrame).toBe(262 * 114);
      expect(m.frameWidth).toBe(336);
      expect(m.frameHeight).toBe(240);
      expect(m.descriptor.screen.activeWidth).toBe(320);
      expect(m.descriptor.screen.activeHeight).toBe(192);
      expect(m.descriptor.screen.borderLeft).toBe(8);
      expect(m.descriptor.screen.borderTop).toBe(24);
    } finally {
      m.destroy();
    }
  });

  it('reports PAL timing for a PAL machine', () => {
    const m = boot('atari800', 'pal');
    try {
      expect(m.cpuClockHz).toBe(1_773_447);
      expect(m.tStatesPerFrame).toBe(312 * 114);
    } finally {
      m.destroy();
    }
  });

  it('takes the region from the locale: US is NTSC, everything else PAL', () => {
    expect(atariRegionForLocale('us')).toBe('ntsc');
    expect(atariRegionForLocale('uk')).toBe('pal');
    expect(atariRegionForLocale(undefined)).toBe('pal');
    const ntsc = atariEntry.create('atari800', null, 'us');
    const pal = atariEntry.create('atari800', null, 'uk');
    try {
      expect(ntsc.tStatesPerFrame).toBe(262 * 114);
      expect(pal.tStatesPerFrame).toBe(312 * 114);
      // GTIA's PAL register: $01 on PAL, $0F on NTSC (bits 1-3 low for PAL).
      expect((ntsc as AtariMachine).gtia.readReg(0xd014) & 0x0e).toBe(0x0e);
      expect((pal as AtariMachine).gtia.readReg(0xd014) & 0x0e).toBe(0x00);
      expect(ntsc.descriptor.locale).toBe('us');
    } finally {
      ntsc.destroy();
      pal.destroy();
    }
  });

  it('fits 16K on the 400 and 48K on the 800', () => {
    const small = boot('atari400');
    const large = boot('atari800');
    try {
      expect(small.ramSize).toBe(0x4000);
      expect(large.ramSize).toBe(0xc000);
      expect(small.memory.ramBankCount).toBe(1);
      expect(large.memory.ramBankCount).toBe(3);
    } finally {
      small.destroy();
      large.destroy();
    }
  });
});

describe('atari boot and frame loop', () => {
  it('resets through the OS vector and runs the program', () => {
    const m = boot();
    try {
      m.setSpeedMultiplier(0); // skip audio generation in the headless test
      m.tick();
      expect(m.gtia.colbk).toBe(0x1e);
      // The frame can end between the instructions of the loop.
      expect(m.cpu.pc).toBeGreaterThanOrEqual(0xe000);
      expect(m.cpu.pc).toBeLessThanOrEqual(0xe006);
    } finally {
      m.destroy();
    }
  });

  it.each([
    ['ntsc', 262 * 114],
    ['pal', 312 * 114],
  ] as const)('keeps %s frames on an exact %i-cycle grid', (region, frameT) => {
    const m = boot('atari800', region);
    try {
      m.setSpeedMultiplier(0);
      const before = m.cpu.tStates;
      for (let f = 0; f < 50; f++) m.tick();
      // DMA steals CPU time *within* the frame, it never lengthens it: after
      // 50 frames the clock is within one instruction of 50 frame periods.
      const drift = m.cpu.tStates - before - 50 * frameT;
      expect(drift).toBeGreaterThanOrEqual(0);
      expect(drift).toBeLessThan(8);
      expect(m.gtia.colbk).toBe(0x1e);
    } finally {
      m.destroy();
    }
  });

  it('routes keyboard events into POKEY once the OS enables the scan', () => {
    const m = boot();
    try {
      m.pokey.writeReg(0x0f, 0x03); // the OS's cold-start SKCTL value
      expect(m.keyDown({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false })).toBe(true);
      expect(m.pokey.kbcode).toBe(0x3f);
      expect(m.keyUp({ code: 'KeyA', key: 'a', shift: false, ctrl: false, alt: false })).toBe(true);
      expect(m.pokey.anyKeyDown).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('reads START/SELECT/OPTION from F2/F3/F4 through CONSOL, held across a reset', () => {
    const m = boot();
    try {
      const f = (code: string) => ({ code, key: code, shift: false, ctrl: false, alt: false });
      expect(m.gtia.readReg(0xd01f) & 0x07).toBe(0x07);
      expect(m.keyDown(f('F2'))).toBe(true);
      expect(m.gtia.readReg(0xd01f) & 0x07).toBe(0x06); // START low
      m.keyDown(f('F4'));
      expect(m.gtia.readReg(0xd01f) & 0x07).toBe(0x02); // START + OPTION
      m.reset(); // e.g. booting an XL with OPTION held to switch BASIC off
      expect(m.gtia.readReg(0xd01f) & 0x07).toBe(0x02);
      m.keyUp(f('F2'));
      m.keyUp(f('F4'));
      expect(m.gtia.readReg(0xd01f) & 0x07).toBe(0x07);
    } finally {
      m.destroy();
    }
  });

  it('drives the joystick directions and trigger through PIA/GTIA', () => {
    const m = boot();
    try {
      m.pressJoystick('up', true, 0);
      m.pressJoystick('fire', true, 0);
      m.pia.writeControl(0, 0x00); // DDR access
      m.pia.writeData(0, 0x00);    // all inputs
      m.pia.writeControl(0, 0x04); // peripheral register
      m.pia.inputA = 0xff & ~m.joyDir[0];
      expect(m.pia.readData(0) & 0x01).toBe(0);
      expect(m.gtia.readReg(0x10) & 0x01).toBe(0);
    } finally {
      m.destroy();
    }
  });
});

/**
 * CPU time left by ANTIC's DMA. The loop `INC $80 / BNE / INC $81 / JMP` is
 * 11 cycles per pass (5 + 3 + 3; the INC $81 path every 256 passes adds 4).
 *
 * DMA off: every line still loses 9 refresh cycles, so the CPU gets
 *   262 * (114 - 9) = 27,510 cycles  ->  ~2,500 passes per frame.
 * GRAPHICS 0 (3 x $70, LMS mode 2, 23 x mode 2, JVB): refresh 262 * 9 = 2,358,
 *   display list 32, character names 24 * 40 = 960, glyph bytes 192 * 40 =
 *   7,680; 11,030 stolen leaves 18,838 cycles  ->  ~1,712 passes per frame.
 */
describe('atari DMA cycle stealing', () => {
  function passesPerFrame(dmactl: number): number {
    const m = new AtariMachine('atari800', null, 'ntsc');
    const rom = new Uint8Array(ATARI_OS_SIZE);
    // $E000: INC $80 ; BNE $E006 ; INC $81 ; JMP $E000
    rom.set([0xe6, 0x80, 0xd0, 0x02, 0xe6, 0x81, 0x4c, 0x00, 0xe0], 0x800);
    rom[0x27fc] = 0x00;
    rom[0x27fd] = 0xe0;
    try {
      m.services.roms.installSystemRom(rom);
      m.reset();
      m.setSpeedMultiplier(0);
      const dl = [0x70, 0x70, 0x70, 0x42, 0x00, 0x30, ...new Array(23).fill(0x02), 0x41, 0x00, 0x20];
      m.memory.ram.set(dl, 0x2000);
      m.antic.dlist = 0x2000;
      m.antic.dmactl = dmactl;
      m.tick(); // settle onto the frame grid
      const count = () => m.memory.ram[0x80] | (m.memory.ram[0x81] << 8);
      const start = count();
      for (let f = 0; f < 10; f++) m.tick();
      return ((count() - start) & 0xffff) / 10;
    } finally {
      m.destroy();
    }
  }

  it('leaves the CPU 105 cycles a line with DMA off', () => {
    const passes = passesPerFrame(0x00);
    expect(passes).toBeGreaterThan(27_510 / 11 * 0.99);
    expect(passes).toBeLessThan(27_510 / 11 * 1.01);
  });

  it('takes a GRAPHICS 0 screen\'s fetches out of the CPU time', () => {
    const passes = passesPerFrame(0x22);
    expect(passes).toBeGreaterThan(18_838 / 11 * 0.99);
    expect(passes).toBeLessThan(18_838 / 11 * 1.01);
  });
});

/**
 * NMI timing. ANTIC posts NMIST and raises the NMI a few cycles into the
 * line (cycle 7 for VBI); the 6502 takes it only after the instruction in
 * progress. So a program polling NMIST for the VBI bit sees it whenever its
 * read lands in that gap, before the OS's NMI handler clears it again. Games
 * wait for the vertical blank exactly this way (Spy's Demise does).
 */
describe('atari NMI timing', () => {
  it('lets a poll of NMIST see the VBI bit before the NMI handler clears it', () => {
    const m = new AtariMachine('atari800', null);
    const rom = new Uint8Array(ATARI_OS_SIZE);
    rom.set([
      0xa9, 0x40, 0x8d, 0x0e, 0xd4, // $E000 LDA #$40 ; STA NMIEN (VBI on)
      0x8d, 0x0f, 0xd4,             // $E005 STA NMIRES
      0xad, 0x0f, 0xd4,             // $E008 LDA NMIST
      0x29, 0x40,                   //       AND #$40
      0xf0, 0xf9,                   //       BEQ $E008
      0xe6, 0x80,                   //       INC $80 (one VBI seen)
      0x4c, 0x05, 0xe0,             //       JMP $E005
    ], 0x800);
    rom.set([0x8d, 0x0f, 0xd4, 0x40], 0x900); // $E100 handler: STA NMIRES ; RTI
    rom[0x27fa] = 0x00; rom[0x27fb] = 0xe1;   // NMI vector -> $E100
    rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;   // reset vector -> $E000
    try {
      m.services.roms.installSystemRom(rom);
      m.reset();
      m.setSpeedMultiplier(0);
      for (let f = 0; f < 60; f++) m.tick();
      // The 9-cycle poll loop lands in the 3-cycle gap about a third of the
      // time: some frames, never all of them.
      const seen = m.memory.readByte(0x80);
      expect(seen).toBeGreaterThan(5);
      expect(seen).toBeLessThan(60);
    } finally {
      m.destroy();
    }
  });
});

describe('atari services', () => {
  it('has a cartridge slot, two drives, a program recorder and its own snapshot format', () => {
    const m = boot();
    try {
      expect(m.services.roms.cartridge).not.toBeNull();
      expect(m.services.disks).not.toBeNull();
      expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
      expect(m.services.tape).not.toBeNull();
      expect(m.services.tape.loaded).toBe(false);
      expect(m.services.snapshots.formats().map(f => f.ext)).toEqual(['.a8state']);
      const cart = new Uint8Array(0x2000).fill(0xa5);
      m.services.roms.cartridge!.insert(cart, 'basic.rom');
      expect(m.memory.readByte(0xa000)).toBe(0xa5);
      expect(m.services.roms.cartridge!.name).toBe('basic.rom');
      m.services.roms.cartridge!.eject();
      expect(m.memory.cart).toBeNull();
    } finally {
      m.destroy();
    }
  });

  it('restarts a running machine after a cartridge swap, and leaves a stopped one', () => {
    const m = boot();
    try {
      const cart = new Uint8Array(0x2000).fill(0xa5);
      const start = vi.spyOn(m, 'start');

      m.services.roms.cartridge!.insert(cart, 'stopped.rom');
      expect(start).not.toHaveBeenCalled();

      void m.start(); // headless start() completes synchronously
      start.mockClear();
      m.services.roms.cartridge!.insert(cart, 'running.rom');
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      m.destroy();
    }
  });

  it('restarts a machine whose start() is still pending when BASIC is mounted', () => {
    // The shell hidden-mounts BASIC while the new machine's start() awaits the
    // audio pipeline; the swap must not leave that machine stopped.
    const m = boot();
    try {
      (m as unknown as { starting: boolean }).starting = true;
      const start = vi.spyOn(m, 'start').mockResolvedValue();
      m.services.roms.cartridge!.insert(new Uint8Array(0x2000), '');
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      m.destroy();
    }
  });

  it('exposes the OS and floating-point ROM as memory regions', () => {
    const m = boot();
    try {
      const os = m.resolveMemoryRegion('rom-os');
      expect(os?.data.length).toBe(0x2000);
      expect(os?.baseAddr).toBe(0xe000);
      const fp = m.resolveMemoryRegion('rom-fp');
      expect(fp?.data.length).toBe(0x800);
      expect(fp?.baseAddr).toBe(0xd800);
    } finally {
      m.destroy();
    }
  });

  it('exports 16K or 48K of RAM for the Save menu', () => {
    const small = boot('atari400');
    const large = boot('atari800');
    try {
      expect(small.services.debug.ramExport()?.data.length).toBe(0x4000);
      expect(large.services.debug.ramExport()?.data.length).toBe(0xc000);
    } finally {
      small.destroy();
      large.destroy();
    }
  });
});

describe('atari ROM entry', () => {
  it('loads the 10K AltirraOS and hides Altirra BASIC in the cartridge slot', () => {
    expect(atariEntry.romSources('atari400')).toEqual(['atari/altirraos-800.rom']);
    expect(atariEntry.romSources('atari800')).toEqual(['atari/altirraos-800.rom']);
    // Both regions share the OS image, so they share one ROM cache key.
    expect(atariEntry.romSources('atari800', 'us')).toEqual(['atari/altirraos-800.rom']);
    expect(atariEntry.bootCartridgeSource?.('atari800')).toBe('atari/altirra-basic.rom');
  });

  it('classifies a 10K OS drop and leaves 8K cartridge images to the media path', () => {
    expect(atariEntry.detectModelForRom?.(new Uint8Array(0x2800), 'zx48k')).toBe('atari800');
    expect(atariEntry.detectModelForRom?.(new Uint8Array(0x2800), 'atari400')).toBe('atari400');
    expect(atariEntry.detectModelForRom?.(new Uint8Array(0x2000), 'atari800')).toBeNull();
  });
});

describe('atari border cropping', () => {
  // The frame is 336x240 with the GRAPHICS 0 area at (8, 24). None crops the
  // whole border, Small half of it, Normal none, as on the other machines;
  // the TEXT overlay is placed on the same assumption.
  it.each([
    [0, [8, 24, 320, 192]],
    [1, [4, 12, 328, 216]],
    [2, [0, 0, 336, 240]],
  ] as const)('border mode %i shows viewport %j', (mode, viewport) => {
    let seen: number[] = [];
    const display = { setViewport: (...v: number[]) => { seen = v; } };
    const m = new AtariMachine('atari800', display as never);
    try {
      m.setBorderSize(mode);
      expect(seen).toEqual([...viewport]);
    } finally {
      m.destroy();
    }
  });
});

/**
 * POKEY writes land on the store's last cycle, as on the 6502 bus, not at
 * the start of the instruction. The Altirra Hardware Reference Manual (5.3,
 * Fig. 8) puts a 1.79 MHz AUDF1=0 timer's IRQST bit 8 cycles after the
 * STIMER write cycle; the machine takes an IRQ at the first instruction
 * boundary after it latches.
 *
 * After STA WSYNC the CPU starts the next line at cycle 0, and no DMA cycle
 * is taken before cycle 16, so the run below is cycle for cycle:
 *   STA STIMER  0-3  (writes at 3: the IRQ latches at 11)
 *   STA IRQEN   4-7  (enables timer 1 at 7, after the old pipeline drains)
 *   CLI         8-9
 *   INX         10-11, 12-13, ...
 * The IRQ latches during the first INX, so the handler sees X=1. With writes
 * at the instruction start it would latch at 8, during CLI, and X would be 0.
 */
describe('atari POKEY write timing', () => {
  function irqX(): number {
    const m = new AtariMachine('atari800', null);
    const rom = new Uint8Array(ATARI_OS_SIZE);
    rom.set([
      0x78,                   // $E000 SEI
      0xa9, 0x00,             //       LDA #0
      0x8d, 0x0e, 0xd4,       //       STA NMIEN
      0x8d, 0x00, 0xd4,       //       STA DMACTL
      0x8d, 0x0e, 0xd2,       //       STA IRQEN
      0xa9, 0x03,             //       LDA #3
      0x8d, 0x0f, 0xd2,       //       STA SKCTL (out of initialisation mode)
      0xa9, 0x40,             //       LDA #$40
      0x8d, 0x08, 0xd2,       //       STA AUDCTL (channel 1 at 1.79 MHz)
      0xa9, 0x00,             //       LDA #0
      0x8d, 0x00, 0xd2,       //       STA AUDF1
      0xa2, 0x00,             //       LDX #0
      0xa9, 0x01,             //       LDA #1
      0x8d, 0x0a, 0xd4,       //       STA WSYNC
      0x8d, 0x09, 0xd2,       //       STA STIMER
      0x8d, 0x0e, 0xd2,       //       STA IRQEN (timer 1)
      0x58,                   //       CLI
      ...new Array(16).fill(0xe8), // INX x 16
      0x4c, 0x39, 0xe0,       // $E039 JMP $E039
    ], 0x800);
    rom.set([0x86, 0x80, 0x4c, 0x02, 0xe1], 0x900); // $E100 STX $80 ; JMP $E102
    rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;          // reset -> $E000
    rom[0x27fe] = 0x00; rom[0x27ff] = 0xe1;          // IRQ -> $E100
    try {
      m.services.roms.installSystemRom(rom);
      m.reset();
      m.setSpeedMultiplier(0);
      m.memory.ram[0x80] = 0xff;
      m.tick();
      return m.memory.ram[0x80];
    } finally {
      m.destroy();
    }
  }

  it('fires a timer 8 cycles after the STIMER store\'s write cycle', () => {
    expect(irqX()).toBe(1);
  });

  it('makes a read-modify-write\'s dummy write a cycle before the real one', () => {
    const m = new AtariMachine('atari800', null);
    const rom = new Uint8Array(ATARI_OS_SIZE);
    rom.set([0xee, 0x00, 0xd2, 0x4c, 0x03, 0xe0], 0x800); // INC $D200 ; JMP $E003
    rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;
    try {
      m.services.roms.installSystemRom(rom);
      m.reset();
      m.setSpeedMultiplier(0);
      const seen: [number, number][] = [];
      const write = m.pokey.writeReg.bind(m.pokey);
      m.pokey.writeReg = (addr: number, v: number) => {
        seen.push([addr & 0x0f, v]);
        write(addr, v);
      };
      m.tick();
      // $D200 reads POT0 (zero before any pot scan) and AUDF1 gets $00, then $01.
      expect(seen.slice(0, 2)).toEqual([[0x00, 0x00], [0x00, 0x01]]);
    } finally {
      m.destroy();
    }
  });
});

/**
 * The CONSOL speaker. On the 400/800 it is the console's internal
 * loudspeaker, apart from the TV sound; the XL has none and routes it to the
 * TV, joining POKEY between the amplifier stages (Altirra Hardware Reference
 * Manual 14.4 CONSOL, appendix E.4).
 */
describe('atari CONSOL speaker routing', () => {
  function externalLevels(model: AtariModel): number[] {
    const m = new AtariMachine(model, null);
    try {
      const levels: number[] = [];
      const set = m.pokey.setExternal.bind(m.pokey);
      m.pokey.setExternal = (level: number) => { levels.push(level); set(level); };
      m.memory.writeByte(0xd01f, 0x08); // speaker line grounded
      m.memory.writeByte(0xd01f, 0x00); // and released
      return levels;
    } finally {
      m.destroy();
    }
  }

  it('feeds the XL speaker into the TV sound between the stages', () => {
    const levels = externalLevels('atari800xl');
    expect(levels.length).toBe(2);
    expect(new Set(levels).size).toBe(2);
  });

  it('keeps the 800 speaker out of the TV sound', () => {
    expect(externalLevels('atari800')).toEqual([]);
  });
});

/**
 * The Sound pane's per-device volumes: the speaker ('beeper-volume') and POKEY
 * ('psg-volume'), each 0-100 and independent. At 100 both keep the hardware's
 * levels. The XL's speaker joins POKEY inside the chip, so its level is struck
 * there rather than in the shared mixer.
 */
describe('atari Sound-pane device volumes', () => {
  const view = (beeper: number, psg: number): SettingsView => ({
    get: <T>(key: string, fallback: T) =>
      (key === 'beeper-volume' ? beeper : key === 'psg-volume' ? psg : fallback) as T,
  });

  it('keeps the 800 hardware balance at 100/100, and each slider fades only its own source', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.applySettings(view(100, 100));
      expect([m.mixer.beeperGain, m.mixer.psgGain]).toEqual([0.5, 1]);
      m.applySettings(view(0, 100));
      expect([m.mixer.beeperGain, m.mixer.psgGain]).toEqual([0, 1]);
      m.applySettings(view(100, 0));
      expect([m.mixer.beeperGain, m.mixer.psgGain]).toEqual([0.5, 0]);
      m.applySettings(view(40, 70));
      expect(m.mixer.beeperGain).toBeCloseTo(0.2, 12);
      expect(m.mixer.psgGain).toBeCloseTo(0.7, 12);
    } finally {
      m.destroy();
    }
  });

  it('mutes the XL speaker with its own slider, inside POKEY', () => {
    const m = new AtariMachine('atari800xl', null);
    try {
      const levels: number[] = [];
      const set = m.pokey.setExternal.bind(m.pokey);
      m.pokey.setExternal = (level: number) => { levels.push(level); set(level); };
      m.applySettings(view(0, 100));
      m.memory.writeByte(0xd01f, 0x08);
      expect(levels.at(-1)).toBe(0);
      m.applySettings(view(100, 100));
      expect(levels.at(-1)).toBeGreaterThan(0);
    } finally {
      m.destroy();
    }
  });

  it('silences POKEY on the XL with the POKEY slider alone', () => {
    // Peak output after AUDC1 steps to forced volume 15.
    const peak = (psg: number): number => {
      const m = new AtariMachine('atari800xl', null);
      try {
        m.applySettings(view(100, psg));
        m.memory.writeByte(0xd201, 0x1f);
        m.pokey.advance(20_000);
        let max = 0;
        for (let i = 0; i < 400; i++) max = Math.max(max, Math.abs(m.pokey.generateSampleStereo().left));
        return max;
      } finally {
        m.destroy();
      }
    };
    expect(peak(100)).toBeGreaterThan(0.1);
    expect(peak(0)).toBe(0);
  });
});

/**
 * NMIEN and WSYNC against the line. Programs run from an OS ROM image at
 * $E000 (offset $0800 in the ROM array), with the NMI vector at $FFFA.
 */
describe('atari NMIEN and WSYNC timing', () => {
  const NMI_HANDLER = 0xe100;

  /** A machine running `program` from $E000, with an NMI handler that does
   *  INC $80 ; RTI. */
  function boot(program: number[]): AtariMachine {
    const m = new AtariMachine('atari800', null);
    const rom = new Uint8Array(ATARI_OS_SIZE);
    rom.set(program, 0x800);
    rom.set([0xe6, 0x80, 0x40], NMI_HANDLER - 0xd800);
    rom[0x27fa] = NMI_HANDLER & 0xff; rom[0x27fb] = NMI_HANDLER >> 8;
    rom[0x27fc] = 0x00; rom[0x27fd] = 0xe0;
    m.services.roms.installSystemRom(rom);
    m.reset();
    m.setSpeedMultiplier(0);
    return m;
  }

  it('takes a DLI whose NMIEN store lands right after the WSYNC that ends the line before it', () => {
    // DLIST $2000: lines 8-39 blank, line 40 one blank line, line 41 one blank
    // line with a DLI, then JVB. The program finds line 40 (VCOUNT 20 is its
    // first read), WSYNCs to the start of line 41 and enables the DLI there.
    const m = boot([
      0xa9, 0x00, 0x8d, 0x0e, 0xd4,       // LDA #0 ; STA NMIEN
      0xa9, 0x00, 0x8d, 0x02, 0xd4,       // DLISTL
      0xa9, 0x20, 0x8d, 0x03, 0xd4,       // DLISTH
      0xa9, 0x22, 0x8d, 0x00, 0xd4,       // DMACTL: DL DMA, normal width
      0xad, 0x0b, 0xd4,                   // wait: LDA VCOUNT
      0xc9, 0x14, 0xd0, 0xf9,             //       CMP #20 ; BNE wait
      0x8d, 0x0a, 0xd4,                   // STA WSYNC
      0xa9, 0x80, 0x8d, 0x0e, 0xd4,       // LDA #$80 ; STA NMIEN
      0x4c, 0x23, 0xe0,                   // spin: JMP spin ($E023)
    ]);
    try {
      [0x70, 0x70, 0x70, 0x70, 0x00, 0x80, 0x41, 0x00, 0x20]
        .forEach((b, i) => m.memory.writeByte(0x2000 + i, b));
      m.memory.writeByte(0x80, 0);
      m.tick();
      expect(m.memory.readByte(0x80)).toBe(1); // this very frame, on line 41
    } finally {
      m.destroy();
    }
  });

  it('raises the RNMI of SYSTEM RESET at the next vertical blank, whatever NMIEN says', () => {
    const m = boot([0x4c, 0x00, 0xe0]); // JMP *
    try {
      m.memory.writeByte(0x80, 0);
      m.pressSystemReset();
      expect(m.antic.nmist & 0x20).toBe(0);     // nothing yet
      expect(m.memory.readByte(0x80)).toBe(0);
      m.tick();
      expect(m.memory.readByte(0x80)).toBe(1);  // one NMI, at line 248
      expect(m.antic.nmist & 0x20).toBe(0x20);
      m.tick();
      expect(m.memory.readByte(0x80)).toBe(1);  // and only one
    } finally {
      m.destroy();
    }
  });

  it('spends the line after a WSYNC that ended past the line end halted', () => {
    // 49 NOPs, INC, STA WSYNC, JMP is 110 CPU cycles a time, more than a
    // line's 105 free ones, so the WSYNC store always ends in a later line
    // than it began. Each such WSYNC then costs a whole line of waiting, so
    // the loop turns over about once per two lines, not once per line.
    const m = boot([
      ...new Array(49).fill(0xea),         // NOPs
      0xe6, 0x81,                          // INC $81
      0x8d, 0x0a, 0xd4,                    // STA WSYNC
      0x4c, 0x00, 0xe0,                    // JMP $E000
    ]);
    try {
      m.memory.writeByte(0x81, 0);
      m.tick();
      // PAL has 312 lines a frame: 156 turns with the wait. Without it each
      // turn takes one line, and the 8-bit counter reads 312 - 256 = 56.
      expect(m.memory.readByte(0x81)).toBe(156);
    } finally {
      m.destroy();
    }
  });
});
