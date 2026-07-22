import { describe, expect, it } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';

function write(machine: Zx8xMachine, address: number, bytes: readonly number[]): void {
  for (let i = 0; i < bytes.length; i++) machine.memory.writeByte(address + i, bytes[i]);
}

describe('ZX81 software-only pseudo-hires', () => {
  it('captures the temporary ROM pattern page at M1 time', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);

    const rom = new Uint8Array(0x2000);
    rom[0x0808] = 0xa5; // I=$08, character 1, forced line-counter row zero
    machine.loadROM(rom);

    // One 32-byte pseudo-hires line in the A15-high echo, terminated by RET.
    // Alternating inverse bytes must produce A5,5A,A5,5A...
    write(machine, 0xc100, Array.from({ length: 32 }, (_, col) => col & 1 ? 0x81 : 0x01));
    write(machine, 0xc120, [0xc9]);

    // Start a real software scanline with a sync pulse, then enter the display
    // stream. Its RET lands at $4210, where another pulse commits the row. A
    // long gap and a third pulse delimit the next software-generated frame.
    write(machine, 0x4200, [
      0x3e, 0x00, 0xd3, 0xff, // LD A,0 / OUT ($FF),A (sync)
      0x3e, 0x08, 0xed, 0x47, // LD A,$08 / LD I,A
      0xc3, 0x00, 0xc1,       // JP $C100
    ]);
    write(machine, 0x4210, [
      0x3e, 0x00, 0xd3, 0xff, // commit the completed row
      0x3e, 0x1e, 0xed, 0x47, // restore normal I while the application runs
      0x06, 0x32, 0x10, 0xfe, // LD B,50 / DJNZ (long inter-frame gap)
      0x3e, 0x00, 0xd3, 0xff, // next frame's sync pulse
      0x3e, 0x08, 0xed, 0x47,
      0x31, 0x00, 0x43,       // LD SP,$4300
      0xc3, 0x00, 0xc1,
    ]);
    write(machine, 0x4300, [0x10, 0x42]);
    machine.cpu.pc = 0x4200;
    machine.cpu.sp = 0x4300;
    machine.cpu.i = 0x1e;

    machine.tick();

    const screen = machine.screenExportBytes();
    const centeredRow = screen.slice(95 * 32, 96 * 32);
    expect(Array.from(centeredRow)).toEqual(
      Array.from({ length: 32 }, (_, col) => col & 1 ? 0x5a : 0xa5),
    );
    expect(machine.ocrScreenForMcp()).toBe('[32x24]\n');
    expect(machine.ocrScreenStyled().mask.every(value => !value)).toBe(true);

    // Once software generation stops, the retained raster expires. In FAST
    // mode there is no ordinary display-file picture to reveal underneath it.
    machine.cpu.pc = 0x0100;
    machine.cpu.halted = true;
    machine.cpu.i = 0x1e;
    machine.memory.writeByte(0x403b, 0x00);
    machine.tick();
    machine.tick();
    machine.tick();
    expect(machine.screenExportBytes().every(value => value === 0)).toBe(true);
  });

  it('intercepts only the M1 byte, not operands read from the high-memory echo', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);
    write(machine, 0xc100, [0xc3, 0x34, 0x12]); // JP $1234
    machine.cpu.pc = 0xc100;

    machine.cpu.step();

    expect(machine.cpu.pc).toBe(0x1234);
  });

  it('rejects unsynchronised high-memory runs instead of rendering noise', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);
    const rom = new Uint8Array(0x2000);
    rom[0x0808] = 0xff;
    machine.loadROM(rom);
    write(machine, 0xc100, [...new Array(32).fill(0x01), 0xc9]);
    write(machine, 0x4300, [0x00, 0x42]);
    machine.cpu.pc = 0xc100;
    machine.cpu.sp = 0x4300;
    machine.cpu.i = 0x08;

    machine.tick();

    expect(machine.screenExportBytes().every(value => value === 0)).toBe(true);
    expect((machine as unknown as { pseudoHiresFrameRows: number }).pseudoHiresFrameRows).toBe(0);
  });

  it('does not replace a real raster with an isolated display-shaped row', () => {
    const machine = new Zx8xMachine('zx81');
    const capture = machine as unknown as {
      pseudoHiresBuilding: Uint8Array;
      pseudoHiresFrame: Uint8Array;
      pseudoHiresBuildingRows: number;
      pseudoHiresFrameRows: number;
      finishPseudoHiresFrame(): void;
    };

    capture.pseudoHiresBuilding[0] = 0xa5;
    capture.pseudoHiresBuilding[32] = 0x5a;
    capture.pseudoHiresBuildingRows = 2;
    capture.finishPseudoHiresFrame();
    expect(capture.pseudoHiresFrameRows).toBe(2);

    capture.pseudoHiresBuilding[0] = 0xff;
    capture.pseudoHiresBuildingRows = 1;
    capture.finishPseudoHiresFrame();

    expect(capture.pseudoHiresFrameRows).toBe(2);
    expect(capture.pseudoHiresFrame[0]).toBe(0xa5);
    expect(capture.pseudoHiresFrame[32]).toBe(0x5a);
  });

  it('captures NMI-paced standard-font rows for a pseudo-hires HUD', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);
    const rom = new Uint8Array(0x2000);
    for (let row = 0; row < 8; row++) rom[0x1e08 + row] = 0x80 >> row;
    machine.loadROM(rom);
    write(machine, 0xc100, new Array(32).fill(0x01));
    write(machine, 0xc120, [0xc9]);

    const capture = machine as unknown as {
      pseudoHiresLastCommittedRowT: number;
      pseudoHiresTextBuilding: Uint8Array;
      pseudoHiresTextBuildingRows: number;
      observePseudoHiresM1(): void;
    };
    capture.pseudoHiresLastCommittedRowT = 0;
    machine.cpu.i = 0x1e;
    machine.cpu.tStates = 1_000;

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 32; col++) {
        machine.cpu.pc = 0xc100 + col;
        capture.observePseudoHiresM1();
        machine.cpu.tStates += 4;
      }
      machine.cpu.pc = 0xc120;
      capture.observePseudoHiresM1();
      machine.cpu.tStates += 75; // consecutive ZX81 scanline starts are 203T apart
    }

    expect(capture.pseudoHiresTextBuildingRows).toBe(8);
    for (let row = 0; row < 8; row++) {
      expect(capture.pseudoHiresTextBuilding[row * 32]).toBe(0x80 >> row);
    }
  });

  it('captures UDG character patterns from RAM at $3000', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);
    machine.memory.setUdgRam(true);
    for (let row = 0; row < 8; row++) machine.memory.writeByte(0x3008 + row, 0x81 >> row);
    write(machine, 0xc100, new Array(32).fill(0x01));
    write(machine, 0xc120, [0xc9]);

    const capture = machine as unknown as {
      pseudoHiresBuilding: Uint8Array;
      pseudoHiresBuildingRows: number;
      observePseudoHiresM1(): void;
    };
    machine.cpu.i = 0x30;
    machine.cpu.tStates = 1_000;

    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 32; col++) {
        machine.cpu.pc = 0xc100 + col;
        capture.observePseudoHiresM1();
        machine.cpu.tStates += 4;
      }
      machine.cpu.pc = 0xc120;
      capture.observePseudoHiresM1();
      machine.cpu.tStates += 75;
    }

    expect(capture.pseudoHiresBuildingRows).toBe(8);
    for (let row = 0; row < 8; row++) {
      expect(capture.pseudoHiresBuilding[row * 32]).toBe(0x81 >> row);
    }
  });

  it('captures WRX bitmap bytes from the unmodified I:R refresh address', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);
    machine.memory.setWrxRam(true);
    // WRX1K display loops commonly emit 31 bytes (248 pixels) per row.
    for (let col = 0; col < 31; col++) machine.memory.writeByte(0x2040 + col, col ^ 0xa5);
    write(machine, 0xc100, new Array(31).fill(0x00));
    write(machine, 0xc11f, [0xc9]);

    const capture = machine as unknown as {
      pseudoHiresBuilding: Uint8Array;
      pseudoHiresBuildingRows: number;
      observePseudoHiresM1(): void;
    };
    machine.cpu.i = 0x20;
    machine.cpu.tStates = 1_000;
    for (let col = 0; col < 31; col++) {
      machine.cpu.r = 0x40 + col;
      machine.cpu.pc = 0xc100 + col;
      capture.observePseudoHiresM1();
      machine.cpu.tStates += 4;
    }
    machine.cpu.pc = 0xc11f;
    capture.observePseudoHiresM1();

    expect(capture.pseudoHiresBuildingRows).toBe(1);
    expect(Array.from(capture.pseudoHiresBuilding.subarray(0, 31))).toEqual(
      Array.from({ length: 31 }, (_, col) => col ^ 0xa5),
    );
    expect(capture.pseudoHiresBuilding[31]).toBe(0);
  });

  it('captures and centers miniature variable-width WRX1K rows', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.setWrxRam(true);
    for (let col = 0; col < 5; col++) machine.memory.writeByte(0x4240 + col, 0x80 >> col);
    write(machine, 0xc100, new Array(5).fill(0x00));
    write(machine, 0xc105, [0xc9]);

    const capture = machine as unknown as {
      pseudoHiresBuilding: Uint8Array;
      pseudoHiresBuildingWidths: Uint8Array;
      pseudoHiresBuildingRows: number;
      observePseudoHiresM1(): void;
    };
    machine.cpu.i = 0x42;
    machine.cpu.tStates = 1_000;
    for (let col = 0; col < 5; col++) {
      machine.cpu.r = 0x40 + col;
      machine.cpu.pc = 0xc100 + col;
      capture.observePseudoHiresM1();
      machine.cpu.tStates += 4;
    }
    machine.cpu.pc = 0xc105;
    capture.observePseudoHiresM1();

    expect(capture.pseudoHiresBuildingRows).toBe(1);
    expect(capture.pseudoHiresBuildingWidths[0]).toBe(5);
    expect(Array.from(capture.pseudoHiresBuilding.subarray(0, 5))).toEqual([0x80, 0x40, 0x20, 0x10, 0x08]);
  });

  it('retains the ordinary display-file renderer when pseudo-hires is inactive', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);
    const rom = new Uint8Array(0x2000);
    rom[0x1e08] = 0x80; // normal I=$1E, character 1, glyph row zero
    machine.loadROM(rom);
    write(machine, 0x400c, [0x00, 0x42]);
    machine.memory.writeByte(0x403b, 0x80); // CDFLAG: SLOW mode
    write(machine, 0x4200, [0x76, 0x01, ...new Array(24).fill(0x76)]);
    machine.cpu.i = 0x1e;
    machine.cpu.pc = 0x0100;
    machine.cpu.halted = true;

    machine.tick();

    expect(machine.screenExportBytes()[0]).toBe(0x80);
  });

  it('blanks ordinary display-file video in FAST mode', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);
    const rom = new Uint8Array(0x2000);
    rom[0x1e08] = 0x80;
    machine.loadROM(rom);
    write(machine, 0x400c, [0x00, 0x42]);
    write(machine, 0x4200, [0x76, 0x01, ...new Array(24).fill(0x76)]);
    machine.memory.writeByte(0x403b, 0x00); // CDFLAG: FAST mode
    machine.cpu.i = 0x1e;
    machine.cpu.pc = 0x0100;
    machine.cpu.halted = true;

    machine.tick();

    expect(machine.screenExportBytes().every(value => value === 0)).toBe(true);
  });
});
