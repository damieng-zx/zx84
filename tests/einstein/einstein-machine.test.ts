import { describe, it, expect, beforeEach } from 'vitest';
import { EinsteinMachine } from '@/machines/einstein/einstein-machine.ts';

function machine(): EinsteinMachine {
  const m = new EinsteinMachine('einstein-tc01', null);
  m.turbo = true; // skip the audio path in headless runFrame
  return m;
}

describe('Einstein BASIC listing pane', () => {
  it('exposes the Xtal BASIC listing from RAM via the frame probe', () => {
    const m = machine();
    m.reset();
    // Write "10 PRINT F" as an Xtal BASIC record at the fixed program base
    // 0x3E01: [len=08][line=10][A2 20 46][00], then the 0x0000 end marker.
    const prog = [0x08, 0x00, 0x0A, 0x00, 0xA2, 0x20, 0x46, 0x00, 0x00, 0x00];
    prog.forEach((b, i) => m.memory.writeByte(0x3E01 + i, b));

    const listing = m.services.inspect?.basicListing?.();
    expect(listing).toEqual([{ lineNumber: 10, text: 'PRINT F' }]);
  });
});

describe('Einstein hidden boot-disk profile', () => {
  it('keeps Xtal DOS on the generic disk-service boot-disk seam', () => {
    const m = machine();

    expect(m.services.disks.bootDisk).toMatchObject({
      source: 'einstein/xtaldos.dsk',
      cacheKey: 'disk-einstein-xtaldos',
    });

    m.services.disks.setBootDiskEnabled(false);
    expect(m.services.disks.bootDisk).toBeNull();
  });
});

describe('EinsteinMemory ROM overlay + toggle', () => {
  let m: EinsteinMachine;
  beforeEach(() => {
    m = machine();
    const rom = new Uint8Array(0x2000);
    rom[0x0000] = 0xAA;
    rom[0x1FFF] = 0xBB;
    m.loadROM(rom);
    m.reset();
  });

  it('overlays the MOS at the bottom, mirrored across 0x0000–0x3FFF', () => {
    expect(m.memory.readByte(0x0000)).toBe(0xAA);
    expect(m.memory.readByte(0x2000)).toBe(0xAA); // mirror
    expect(m.memory.readByte(0x1FFF)).toBe(0xBB);
    expect(m.memory.readByte(0x4000)).toBe(0xFF); // upper ROM window reads 0xFF
  });

  it('writes fall through to RAM even while the ROM is mapped', () => {
    m.memory.writeByte(0x0000, 0x55);
    expect(m.memory.readByte(0x0000)).toBe(0xAA);  // still ROM for reads
    expect(m.memory.ramSnapshot()[0]).toBe(0x55);  // but RAM took the write
  });

  it('port 0x24 toggles the ROM overlay in and out', () => {
    m.memory.writeByte(0x0000, 0x55);
    expect(m.memory.romPagedIn).toBe(true);
    m.cpu.portOut(0x24, 0x00);                     // any access toggles
    expect(m.memory.romPagedIn).toBe(false);
    expect(m.memory.readByte(0x0000)).toBe(0x55);  // now reads RAM
    m.cpu.portIn(0x24);                            // read toggles too
    expect(m.memory.romPagedIn).toBe(true);
  });
});

describe('Einstein I/O port decode', () => {
  let m: EinsteinMachine;
  beforeEach(() => { m = machine(); m.reset(); });

  it('routes VDP register and VRAM writes through ports 0x08/0x09', () => {
    // Control-port (0x09) two-byte register write: R1 = 0x50.
    m.cpu.portOut(0x09, 0x50);
    m.cpu.portOut(0x09, 0x80 | 1);
    expect(m.vdp.regs[1]).toBe(0x50);
    // VRAM write via 0x09 (address setup) + 0x08 (data).
    m.cpu.portOut(0x09, 0x00);
    m.cpu.portOut(0x09, 0x40); // write setup, address 0
    m.cpu.portOut(0x08, 0x99);
    expect(m.vdp.vram[0]).toBe(0x99);
  });

  it('scans the keyboard through the AY (port A select, port B read)', () => {
    m.keyboard.handleKeyEvent('KeyA', true); // A = matrix [6,6]
    // Select AY register 14 (port A) and drive row 6 low (active-low select).
    m.cpu.portOut(0x02, 14);
    m.cpu.portOut(0x03, 0xFF & ~(1 << 6));
    // Select AY register 15 (port B) and read the columns.
    m.cpu.portOut(0x02, 15);
    const cols = m.cpu.portIn(0x02);
    expect(cols).toBe(0xFF & ~(1 << 6)); // column 6 pulled low by the key
  });
});

describe('Einstein I/O mirrors (MAME einstein_io)', () => {
  let m: EinsteinMachine;
  beforeEach(() => { m = machine(); m.reset(); });

  it('decodes only A0 on the TC-01 VDP: 0x0A is data, 0x0F is control', () => {
    m.cpu.portOut(0x0F, 0x00);
    m.cpu.portOut(0x0D, 0x40);                // write setup, address 0
    m.cpu.portOut(0x0A, 0x5A);                // data via a mirror
    expect(m.vdp.vram[0]).toBe(0x5A);
    m.cpu.portOut(0x0B, 0x42);
    m.cpu.portOut(0x0F, 0x80 | 7);            // R7 via a mirror
    expect(m.vdp.regs[7]).toBe(0x42);
  });

  it('mirrors the WD1770 at 0x1C-0x1F', () => {
    m.cpu.portOut(0x1D, 0x27);                // track register via mirror
    expect(m.cpu.portIn(0x19)).toBe(0x27);
    m.cpu.portOut(0x1E, 0x05);                // sector register via mirror
    expect(m.cpu.portIn(0x1A)).toBe(0x05);
  });

  it('mirrors the AY at 0x06/0x07', () => {
    m.cpu.portOut(0x06, 8);                   // select R8 (volume A)
    m.cpu.portOut(0x07, 0x0C);
    m.cpu.portOut(0x02, 8);
    expect(m.cpu.portIn(0x02)).toBe(0x0C);
  });

  it('reads a centred joystick from the TC-01 ADC0844 at 0x38-0x3F', () => {
    expect(m.cpu.portIn(0x38)).toBe(0x80);
    expect(m.cpu.portIn(0x3F)).toBe(0x80);
  });

  it('resets the PSG on a port 0x00 access', () => {
    m.cpu.portOut(0x02, 8);
    m.cpu.portOut(0x03, 0x0C);
    m.cpu.portOut(0x00, 0x00);
    m.cpu.portOut(0x02, 8);
    expect(m.cpu.portIn(0x02)).toBe(0x00);
  });
});

describe('Einstein reset strobe (ports 0x00/0x01)', () => {
  // MAME wires this decode to both chips' /RESET (reset_r / reset_w call
  // m_psg->reset() *and* m_fdc->reset()), so a strobe clears the controller as
  // well as the PSG. The drive mechanism is not reset: the heads stay put.
  let m: EinsteinMachine;
  beforeEach(() => { m = machine(); m.reset(); });

  /** Let a Type I command's BUSY pulse expire so its registers settle. */
  function settle(): void {
    for (let i = 0; i < 32 && (m.fdc.readStatus() & 0x01) !== 0; i++) m.fdc.readStatus();
  }

  /** Seek to `track` with the track register left holding the target. */
  function seekTo(track: number): void {
    m.cpu.portOut(0x23, 0x01);            // select drive 0, side 0
    m.cpu.portOut(0x18, 0x00); settle();  // restore
    m.cpu.portOut(0x1B, track);
    m.cpu.portOut(0x18, 0x10); settle();  // seek
  }

  it('a port 0x00 write resets the WD1770: the track register returns to 0', () => {
    seekTo(9);
    expect(m.fdc.readTrack()).toBe(9);       // the seek landed
    m.cpu.portOut(0x00, 0x00);
    settle();
    expect(m.fdc.readTrack()).toBe(0);
  });

  it('a port 0x01 write resets the WD1770 too', () => {
    seekTo(7);
    expect(m.fdc.readTrack()).toBe(7);
    m.cpu.portOut(0x01, 0x00);
    settle();
    expect(m.fdc.readTrack()).toBe(0);
  });

  it('a port 0x00 read resets the WD1770 as well as the PSG', () => {
    seekTo(5);
    expect(m.fdc.readTrack()).toBe(5);
    m.cpu.portIn(0x00);
    settle();
    expect(m.fdc.readTrack()).toBe(0);
  });

  it('leaves the drive head where it was parked (only the controller resets)', () => {
    seekTo(12);
    expect(m.fdc.currentTrack).toBe(12);
    m.cpu.portOut(0x00, 0x00);
    settle();
    // After a /MR the track register reads 0 but a SEEK re-derives the position
    // from the register, so the mechanism is where it physically sat.
    expect(m.fdc.currentTrack).toBe(12);
  });
});

describe('Einstein CTC→IM2 interrupt path', () => {
  it('services a CTC timer interrupt through the ISR during a frame', () => {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    // Boot: IM 2; I := 0; EI; then loop forever with interrupts enabled.
    let p = 0;
    rom[p++] = 0xED; rom[p++] = 0x5E;       // IM 2
    rom[p++] = 0x3E; rom[p++] = 0x00;       // LD A,0
    rom[p++] = 0xED; rom[p++] = 0x47;       // LD I,A
    rom[p++] = 0xFB;                        // EI
    rom[p++] = 0x18; rom[p++] = 0xFE;       // JR $  (loop at 0x0007)
    // IM 2 vector table entry for CTC channel 0 (vector base 0x40 → 0x0040):
    rom[0x0040] = 0x00; rom[0x0041] = 0x01; // ISR at 0x0100
    // ISR: write a sentinel to RAM 0x8000, then EI + RETI.
    let q = 0x0100;
    rom[q++] = 0x3E; rom[q++] = 0xEE;       // LD A,0xEE
    rom[q++] = 0x32; rom[q++] = 0x00; rom[q++] = 0x80; // LD (0x8000),A
    rom[q++] = 0xFB;                        // EI
    rom[q++] = 0xED; rom[q++] = 0x4D;       // RETI
    m.loadROM(rom);
    m.reset();

    // Program CTC channel 0 as a timer with interrupts enabled: vector base
    // 0x40, timer mode, /16 prescaler, time constant 255. The CTC's timer
    // prescaler runs off the undivided 4MHz CPU clock, so this underflows
    // every 16×255 = 4080 T-states — several times within a PAL field
    // (80000 T) as addCycles runs.
    m.cpu.portOut(0x28, 0x40);              // vector base (bit0 = 0)
    m.cpu.portOut(0x28, 0x01 | 0x80 | 0x04); // control: timer+int+/16+TCfollows
    m.cpu.portOut(0x28, 0xFF);              // time constant = 255

    expect(m.memory.ramSnapshot()[0x8000]).toBe(0x00); // sentinel not yet written
    m.tick();                               // run one PAL field
    expect(m.memory.ramSnapshot()[0x8000]).toBe(0xEE); // ISR ran via IM 2
  });

  it('the timer prescaler runs off the undivided 4MHz CPU clock, not a halved 2MHz', () => {
    // Regression pin: the CTC device clock that drives the timer-mode
    // prescaler is the full CPU clock (MAME's XTAL/2 wiring only affects
    // channels 0-2's external CLK/TRG pins — see Z80Ctc.inputClockDivide).
    // A wrongly halved clock doubles every timer
    // period; this checks the exact undivided underflow point.
    const m = machine();
    m.reset();
    m.cpu.portOut(0x28, 0x01 | 0x80 | 0x04); // channel 0: timer+int+/16+TCfollows
    m.cpu.portOut(0x28, 0xFF);               // time constant = 255
    // /16 prescaler x 255 = 4080 T-states to underflow once.
    m.ctc.addCycles(4079);
    expect(m.ctc.interruptPending).toBe(false);
    m.ctc.addCycles(1);
    expect(m.ctc.interruptPending).toBe(true);
  });
});

describe('Einstein CTC CLK/TRG0-2', () => {
  it('clocks counter-mode channels 0-2 from the 2MHz system clock', () => {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    rom[0] = 0xF3; rom[1] = 0x76;            // DI ; HALT
    m.loadROM(rom);
    m.reset();
    // Channel 2: counter mode, interrupt enabled, TC = 200. One PAL field
    // is ~80000 T = ~40000 edges at 2MHz, far more than 200.
    m.cpu.portOut(0x2A, 0x01 | 0x40 | 0x80 | 0x04);
    m.cpu.portOut(0x2A, 200);
    m.tick();
    expect(m.ctc.interruptPending).toBe(true);
  });
});

describe('Einstein keyboard / ADC / fire interrupts', () => {
  /** ROM: IM 2, I = 0, EI, spin. Vectors 0xF7/0xFB/0xFD point to ISRs that
   *  record their id at 0x8000 and count at 0x8001, then (for the keyboard
   *  and ADC) read the source's port to clear it, EI, RETI. */
  function boot(): EinsteinMachine {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    let p = 0;
    for (const b of [0xED, 0x5E, 0x3E, 0x00, 0xED, 0x47, 0xFB, 0x18, 0xFE]) rom[p++] = b;
    const isr = (vector: number, at: number, id: number, clearPort: number | null) => {
      rom[vector] = at & 0xFF; rom[vector + 1] = at >> 8;
      const code = [0x3E, id, 0x32, 0x00, 0x80,        // LD A,id ; LD (8000),A
        0x21, 0x01, 0x80, 0x34];                         // LD HL,8001 ; INC (HL)
      if (clearPort !== null) code.push(0xDB, clearPort); // IN A,(port)
      code.push(0xFB, 0xED, 0x4D);                       // EI ; RETI
      rom.set(code, at);
    };
    isr(0xF7, 0x0200, 1, 0x20);
    isr(0xFB, 0x0300, 2, 0x38);
    isr(0xFD, 0x0400, 3, null);
    m.loadROM(rom);
    m.reset();
    return m;
  }
  const ram = (m: EinsteinMachine, a: number) => m.memory.ramSnapshot()[a];

  it('keeps the keyboard interrupt masked at reset', () => {
    const m = boot();
    m.keyboard.handleKeyEvent('KeyA', true);
    m.cpu.portOut(0x02, 14); m.cpu.portOut(0x03, 0x00); // scan every line
    m.tick(); m.tick();
    expect(ram(m, 0x8001)).toBe(0);
  });

  it('raises the keyboard interrupt (vector 0xF7) once enabled via port 0x20', () => {
    const m = boot();
    m.keyboard.handleKeyEvent('KeyA', true);
    m.cpu.portOut(0x02, 14); m.cpu.portOut(0x03, 0x00);
    m.cpu.portOut(0x20, 0x00);                // bit0 clear = enabled
    m.tick(); m.tick();
    expect(ram(m, 0x8000)).toBe(1);
    // Held once per 50Hz scan and cleared by the ISR's port-0x20 read, so
    // two frames yield at most two entries, not a storm.
    expect(ram(m, 0x8001)).toBeGreaterThanOrEqual(1);
    expect(ram(m, 0x8001)).toBeLessThanOrEqual(2);
  });

  it('clears a pending keyboard interrupt when port 0x20 is read', () => {
    const m = machine();
    m.reset();
    m.boardIntPending = 0x01;
    m.cpu.portIn(0x20);
    expect(m.boardIntPending & 0x01).toBe(0);
  });

  it('raises the ADC interrupt (vector 0xFB) after a conversion is started', () => {
    const m = boot();
    m.cpu.portOut(0x21, 0x00);                // ADC interrupt enabled
    m.cpu.portOut(0x38, 0x00);                // start conversion
    m.tick();
    expect(ram(m, 0x8000)).toBe(2);
    expect(ram(m, 0x8001)).toBe(1);           // cleared by the ISR's read
  });

  it('raises the fire interrupt (vector 0xFD) and clears it on acknowledge', () => {
    const m = boot();
    m.keyboard.setJoystick('fire1', true);
    m.cpu.portOut(0x25, 0x00);                // fire interrupt enabled
    m.tick();                                  // scan at end of frame
    m.keyboard.setJoystick('fire1', false);   // so no re-raise at next scan
    m.tick();                                  // serviced during this one
    expect(ram(m, 0x8000)).toBe(3);
    expect(ram(m, 0x8001)).toBe(1);           // acknowledge cleared it
    expect(m.boardIntPending & 0x04).toBe(0);
  });

  it('prioritises the keyboard over the fire button', () => {
    const m = boot();
    m.boardIntMask = 0x07;
    m.boardIntPending = 0x05;                  // keyboard + fire
    m.tick();
    // Keyboard went first, then fire; the last writer is fire (3) only if
    // keyboard was taken first — check the count and final id.
    expect(ram(m, 0x8001)).toBe(2);
    expect(ram(m, 0x8000)).toBe(3);
  });
});

describe('Einstein runFrame smoke', () => {
  it('renders a frame without throwing and fills the backdrop', () => {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    rom[0] = 0xF3; rom[1] = 0x76; // DI ; HALT
    m.loadROM(rom);
    m.reset();
    m.tick();
    // Backdrop is colour 0 (R7 low nibble) = black; the buffer is non-empty.
    expect(m.pixels.length).toBe(320 * 240 * 4);
    expect(m.pixels[3]).toBe(0xFF); // alpha of the first pixel
  });
});

describe('Einstein daisy chain: CTC IEO gates the board interrupts', () => {
  // Zilog daisy chain: once the CPU acknowledges a CTC channel, the CTC holds
  // IEO low until it sees RETI (ED 4D), so a lower-priority device (here the
  // ADC, below the CTC) cannot interrupt even if the ISR re-enables
  // interrupts with EI. RETN does not end the CTC's service.
  /** CTC ch0 ISR: log 0xC0, start an ADC conversion, EI, spin ~650T (well
   *  past the ADC's 160T conversion), log 0xC1, then `ret` (RETI or RETN).
   *  ADC ISR: log 0xAD, read port 0x38 to clear it, EI, RETI. */
  function run(ret: number): number[] {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    const log = (id: number) => [0x2A, 0x02, 0x80, 0x36, id, 0x23, 0x22, 0x02, 0x80];
    rom.set([0xED, 0x5E, 0x3E, 0x00, 0xED, 0x47,      // IM 2 ; LD A,0 ; LD I,A
      0x21, 0x10, 0x80, 0x22, 0x02, 0x80,             // LD HL,8010 ; LD (8002),HL
      0xFB, 0x18, 0xFE], 0);                          // EI ; JR $
    rom[0x40] = 0x00; rom[0x41] = 0x01;               // CTC ch0 vector -> 0x0100
    rom.set([...log(0xC0), 0xD3, 0x38, 0xFB, 0x06, 50, 0x10, 0xFE,
      ...log(0xC1), 0xED, ret], 0x0100);
    rom[0xFB] = 0x00; rom[0xFC] = 0x02;               // ADC vector -> 0x0200
    rom.set([...log(0xAD), 0xDB, 0x38, 0xFB, 0xED, 0x4D], 0x0200);
    m.loadROM(rom);
    m.reset();
    m.cpu.portOut(0x21, 0x00);                        // ADC interrupt enabled
    m.cpu.portOut(0x28, 0x40);                        // CTC vector base 0x40
    m.cpu.portOut(0x28, 0x01 | 0x80 | 0x04);          // ch0 timer, int, /16, TC follows
    m.cpu.portOut(0x28, 0xFF);                        // 4080T period
    m.tick();
    return Array.from(m.memory.ramSnapshot().subarray(0x8010, 0x8016));
  }

  it('holds the ADC off until the CTC ISR executes RETI, despite EI', () => {
    expect(run(0x4D).slice(0, 3)).toEqual([0xC0, 0xC1, 0xAD]);
  });

  it('RETN leaves the CTC under service, so nothing below it (or itself) interrupts again', () => {
    expect(run(0x45)).toEqual([0xC0, 0xC1, 0, 0, 0, 0]);
  });
});

describe('Einstein daisy chain: the keyboard outranks the CTC', () => {
  // MAME's einstein_daisy_chain is { keyboard, CTC, ADC, PIO, fire }, so the
  // keyboard sits ABOVE the CTC: a key-down request is serviced even while a
  // CTC channel is under service (the CTC's IEO low), unlike the ADC and the
  // fire button below it. Priorities here came from reading the board's chain
  // order; the emulator used to put the CTC first, which starved the keyboard
  // behind the 50 Hz scan while a CTC handle was running.
  /** CTC ch0 ISR: log 0xC0, EI, spin ~650T, log 0xC1, then RETN — leaving the
   *  CTC under service. Keyboard ISR: log 0x4B, read port 0x20 to clear, EI,
   *  RETI. A key is held down from the start so the 50 Hz scan raises it. */
  function run(): number[] {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    const log = (id: number) => [0x2A, 0x02, 0x80, 0x36, id, 0x23, 0x22, 0x02, 0x80];
    rom.set([0xED, 0x5E, 0x3E, 0x00, 0xED, 0x47,      // IM 2 ; LD A,0 ; LD I,A
      0x21, 0x10, 0x80, 0x22, 0x02, 0x80,             // LD HL,8010 ; LD (8002),HL
      0xFB, 0x18, 0xFE], 0);                          // EI ; JR $
    rom[0x40] = 0x00; rom[0x41] = 0x01;               // CTC ch0 vector -> 0x0100
    rom.set([...log(0xC0), 0xFB, 0x06, 50, 0x10, 0xFE, ...log(0xC1), 0xED, 0x45], 0x0100);
    rom[0xF7] = 0x00; rom[0xF8] = 0x02;               // keyboard vector -> 0x0200
    rom.set([...log(0x4B), 0xDB, 0x20, 0xFB, 0xED, 0x4D], 0x0200);
    m.loadROM(rom);
    m.reset();
    m.cpu.portOut(0x28, 0x40);                        // CTC vector base 0x40
    m.cpu.portOut(0x28, 0x01 | 0x80 | 0x04);          // ch0 timer, int, /16, TC follows
    m.cpu.portOut(0x28, 0xFF);                        // 4080T period
    m.cpu.portOut(0x20, 0x00);                        // keyboard interrupt enabled
    m.keyboard.handleKeyEvent('KeyA', true);
    m.cpu.portOut(0x02, 14); m.cpu.portOut(0x03, 0x00); // scan every row
    for (let f = 0; f < 4; f++) m.tick();
    return Array.from(m.memory.ramSnapshot().subarray(0x8010, 0x8018));
  }

  it('serves a held key while the CTC is under service (above it in the chain)', () => {
    const log = run();
    expect(log).toContain(0x4B);
    // The keyboard handler ran, and the CTC handle still logged both ends.
    expect(log.slice(0, 2)).toEqual([0xC0, 0xC1]);
  });

  it('still takes the CTC interrupt first when nothing above it is asking', () => {
    const m = machine();
    const rom = new Uint8Array(0x2000);
    rom.set([0xED, 0x5E, 0x3E, 0x00, 0xED, 0x47, 0xFB, 0x18, 0xFE], 0);
    rom[0x40] = 0x00; rom[0x41] = 0x01;
    rom.set([0x3E, 0xEE, 0x32, 0x00, 0x80, 0xFB, 0xED, 0x4D], 0x0100);
    m.loadROM(rom);
    m.reset();
    m.cpu.portOut(0x28, 0x40);
    m.cpu.portOut(0x28, 0x01 | 0x80 | 0x04);
    m.cpu.portOut(0x28, 0xFF);
    m.tick();
    expect(m.memory.ramSnapshot()[0x8000]).toBe(0xEE);
  });
});
