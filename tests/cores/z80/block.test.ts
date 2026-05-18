/**
 * Z80 block instruction tests — LDI/LDIR, CPI/CPIR, INI/IND/INIR/INDR,
 * OUTI/OUTD/OTIR/OTDR, IN/OUT, OUT (C),r, IN r,(C).
 */
import { describe, it, expect } from 'vitest';
import { newCpu, load, step, type Harness, F_S, F_Z, F_H, F_PV, F_N } from './_harness.ts';

describe('Z80 — Block ops (ED-prefix)', () => {
  it('LDI copies a byte, increments HL/DE, decrements BC', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000; h.cpu.de = 0xC100; h.cpu.bc = 0x0003;
    h.mem[0xC000] = 0x42;
    load(h.mem, 0, 0xED, 0xA0);
    step(h);
    expect(h.mem[0xC100]).toBe(0x42);
    expect(h.cpu.hl).toBe(0xC001);
    expect(h.cpu.de).toBe(0xC101);
    expect(h.cpu.bc).toBe(0x0002);
    expect(h.cpu.f & F_PV).toBe(F_PV); // BC != 0
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_H).toBe(0);
  });

  it('LDIR repeats until BC = 0', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000; h.cpu.de = 0xC100; h.cpu.bc = 0x0004;
    for (let i = 0; i < 4; i++) h.mem[0xC000 + i] = 0x10 + i;
    load(h.mem, 0, 0xED, 0xB0);
    for (let i = 0; i < 16 && h.cpu.bc !== 0; i++) h.cpu.step();
    expect(h.cpu.bc).toBe(0);
    expect(h.cpu.pc).toBe(2);
    for (let i = 0; i < 4; i++) expect(h.mem[0xC100 + i]).toBe(0x10 + i);
    expect(h.cpu.f & F_PV).toBe(0); // BC = 0 → PV clear
  });

  it('CPI compares A with (HL), sets Z if equal, decrements BC', () => {
    const h = newCpu();
    h.cpu.a = 0x42; h.cpu.hl = 0xC000; h.cpu.bc = 0x0003;
    h.mem[0xC000] = 0x42;
    load(h.mem, 0, 0xED, 0xA1);
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
    expect(h.cpu.hl).toBe(0xC001);
    expect(h.cpu.bc).toBe(0x0002);
    expect(h.cpu.a).toBe(0x42); // A unchanged
  });

  it('LDD copies byte and decrements HL, DE, BC (reverse direction from LDI)', () => {
    const h = newCpu();
    h.cpu.hl = 0xC002; h.cpu.de = 0xC102; h.cpu.bc = 0x0003;
    h.mem[0xC002] = 0x55;
    load(h.mem, 0, 0xED, 0xA8); // LDD
    step(h);
    expect(h.mem[0xC102]).toBe(0x55);
    expect(h.cpu.hl).toBe(0xC001); // decremented
    expect(h.cpu.de).toBe(0xC101); // decremented
    expect(h.cpu.bc).toBe(0x0002);
    expect(h.cpu.f & F_PV).toBe(F_PV); // BC != 0
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_H).toBe(0);
  });

  it('LDDR repeats copying backwards until BC = 0', () => {
    const h = newCpu();
    h.cpu.hl = 0xC003; h.cpu.de = 0xC103; h.cpu.bc = 0x0004;
    for (let i = 0; i < 4; i++) h.mem[0xC000 + i] = 0x20 + i;
    load(h.mem, 0, 0xED, 0xB8); // LDDR
    for (let i = 0; i < 16 && h.cpu.bc !== 0; i++) h.cpu.step();
    expect(h.cpu.bc).toBe(0);
    expect(h.cpu.pc).toBe(2);
    for (let i = 0; i < 4; i++) expect(h.mem[0xC100 + i]).toBe(0x20 + i);
    expect(h.cpu.f & F_PV).toBe(0); // BC = 0 → PV clear
  });

  it('CPD compares A with (HL) and decrements HL (reverse from CPI)', () => {
    const h = newCpu();
    h.cpu.a = 0x42; h.cpu.hl = 0xC002; h.cpu.bc = 0x0003;
    h.mem[0xC002] = 0x42;
    load(h.mem, 0, 0xED, 0xA9); // CPD
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
    expect(h.cpu.hl).toBe(0xC001); // decremented
    expect(h.cpu.bc).toBe(0x0002);
    expect(h.cpu.a).toBe(0x42);
  });

  it('CPDR searches backwards; stops when match found', () => {
    const h = newCpu();
    // Place the target at 0xC001, search backwards from 0xC002
    h.cpu.a = 0x77; h.cpu.hl = 0xC002; h.cpu.bc = 0x0003;
    h.mem[0xC002] = 0x00; // no match
    h.mem[0xC001] = 0x77; // match here
    h.mem[0xC000] = 0x00;
    load(h.mem, 0, 0xED, 0xB9); // CPDR
    for (let i = 0; i < 16 && (h.cpu.f & F_Z) === 0; i++) h.cpu.step();
    expect(h.cpu.f & F_Z).toBe(F_Z); // match found
    expect(h.cpu.hl).toBe(0xC000);   // stopped after decrement past match addr
    expect(h.cpu.bc).toBe(0x0001);
  });
});

describe('Z80 — INI / IND / INIR / INDR block I/O', () => {
  it('INI reads from port BC, writes to (HL), increments HL, decrements B', () => {
    const h = newCpu();
    h.cpu.bc = 0x0234; // port 0x0234, B=0x02
    h.cpu.hl = 0xC000;
    h.ports.set(0x0234, 0x42);
    load(h.mem, 0, 0xED, 0xA2); // INI
    step(h);
    expect(h.mem[0xC000]).toBe(0x42);
    expect(h.cpu.hl).toBe(0xC001);    // incremented
    expect(h.cpu.b).toBe(0x01);       // B decremented
    expect(h.cpu.c).toBe(0x34);       // C unchanged
    expect(h.cpu.f & F_Z).toBe(0);    // B != 0
  });

  it('INI: Z set when B decrements to zero', () => {
    const h = newCpu();
    h.cpu.bc = 0x0134; // B=1 → becomes 0 after INI
    h.cpu.hl = 0xC000;
    h.ports.set(0x0134, 0x00);
    load(h.mem, 0, 0xED, 0xA2);
    step(h);
    expect(h.cpu.b).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
  });

  it('INI: N flag is bit 7 of the value read from port', () => {
    const h = newCpu();
    h.cpu.bc = 0x0134;
    h.cpu.hl = 0xC000;
    h.ports.set(0x0134, 0x80); // bit 7 set → N=1
    load(h.mem, 0, 0xED, 0xA2);
    step(h);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('IND reads from port BC, writes to (HL), decrements HL and B', () => {
    const h = newCpu();
    h.cpu.bc = 0x0234;
    h.cpu.hl = 0xC002;
    h.ports.set(0x0234, 0x77);
    load(h.mem, 0, 0xED, 0xAA); // IND
    step(h);
    expect(h.mem[0xC002]).toBe(0x77);
    expect(h.cpu.hl).toBe(0xC001); // decremented
    expect(h.cpu.b).toBe(0x01);
  });

  it('INIR loops until B = 0, incrementing HL each iteration', () => {
    const h = newCpu();
    h.cpu.bc = 0x0320; // B=3, C=0x20 (port lo byte)
    h.cpu.hl = 0xC000;
    h.ports.set(0x0320, 0x10);
    h.ports.set(0x0220, 0x20);
    h.ports.set(0x0120, 0x30);
    load(h.mem, 0, 0xED, 0xB2); // INIR
    for (let i = 0; i < 16 && h.cpu.b !== 0; i++) h.cpu.step();
    expect(h.cpu.b).toBe(0);
    expect(h.cpu.hl).toBe(0xC003);
    expect(h.cpu.pc).toBe(2);
  });

  it('INDR loops until B = 0, decrementing HL each iteration', () => {
    const h = newCpu();
    h.cpu.bc = 0x0220;
    h.cpu.hl = 0xC002;
    h.ports.set(0x0220, 0xAA);
    h.ports.set(0x0120, 0xBB);
    load(h.mem, 0, 0xED, 0xBA); // INDR
    for (let i = 0; i < 16 && h.cpu.b !== 0; i++) h.cpu.step();
    expect(h.cpu.b).toBe(0);
    expect(h.cpu.hl).toBe(0xC000);
    expect(h.cpu.pc).toBe(2);
  });
});

describe('Z80 — OUTI / OUTD / OTIR / OTDR block output', () => {
  it('OUTI increments HL first, then writes (HL-original) to port BC-after-decrement', () => {
    const h = newCpu();
    h.cpu.bc = 0x0234;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x42;
    load(h.mem, 0, 0xED, 0xA3); // OUTI
    step(h);
    expect(h.cpu.hl).toBe(0xC001);
    expect(h.cpu.b).toBe(0x01);
    expect(h.cpu.c).toBe(0x34);
    expect(h.portWrites[0]).toEqual({ port: 0x0134, val: 0x42 });
    expect(h.cpu.f & F_Z).toBe(0);
  });

  it('OUTI: Z set when B decrements to zero', () => {
    const h = newCpu();
    h.cpu.bc = 0x0134;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x00;
    load(h.mem, 0, 0xED, 0xA3);
    step(h);
    expect(h.cpu.b).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
  });

  it('OUTD decrements HL before write, decrements B, writes to port', () => {
    const h = newCpu();
    h.cpu.bc = 0x0234;
    h.cpu.hl = 0xC002;
    h.mem[0xC002] = 0x77;
    load(h.mem, 0, 0xED, 0xAB); // OUTD
    step(h);
    expect(h.cpu.hl).toBe(0xC001);
    expect(h.cpu.b).toBe(0x01);
    expect(h.portWrites[0]).toEqual({ port: 0x0134, val: 0x77 });
  });

  it('OTIR loops until B = 0, outputting each byte from sequential addresses', () => {
    const h = newCpu();
    h.cpu.bc = 0x0220;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x11;
    h.mem[0xC001] = 0x22;
    load(h.mem, 0, 0xED, 0xB3); // OTIR
    for (let i = 0; i < 16 && h.cpu.b !== 0; i++) h.cpu.step();
    expect(h.cpu.b).toBe(0);
    expect(h.cpu.hl).toBe(0xC002);
    expect(h.cpu.pc).toBe(2);
    expect(h.portWrites[0].val).toBe(0x11);
    expect(h.portWrites[1].val).toBe(0x22);
  });

  it('OTDR loops until B = 0, outputting bytes in reverse', () => {
    const h = newCpu();
    h.cpu.bc = 0x0220;
    h.cpu.hl = 0xC001;
    h.mem[0xC001] = 0xAA;
    h.mem[0xC000] = 0xBB;
    load(h.mem, 0, 0xED, 0xBB); // OTDR
    for (let i = 0; i < 16 && h.cpu.b !== 0; i++) h.cpu.step();
    expect(h.cpu.b).toBe(0);
    expect(h.cpu.hl).toBe(0xBFFF);
    expect(h.cpu.pc).toBe(2);
  });
});

describe('Z80 — IN / OUT', () => {
  it('IN A,(n) reads from port (A<<8)|n', () => {
    const h = newCpu();
    h.cpu.a = 0xFE;
    h.ports.set(0xFE7F, 0x99);
    load(h.mem, 0, 0xDB, 0x7F); // IN A,($7F)
    step(h);
    expect(h.cpu.a).toBe(0x99);
    expect(h.portReads[0]).toBe(0xFE7F);
  });

  it('OUT (n),A writes A to port (A<<8)|n', () => {
    const h = newCpu();
    h.cpu.a = 0x12;
    load(h.mem, 0, 0xD3, 0x34); // OUT ($34),A
    step(h);
    expect(h.portWrites[0]).toEqual({ port: 0x1234, val: 0x12 });
  });

  it('IN r,(C) uses BC as port and sets S/Z/P from input', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234;
    h.ports.set(0x1234, 0x80);
    load(h.mem, 0, 0xED, 0x40); // IN B,(C)
    step(h);
    expect(h.cpu.b).toBe(0x80);
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_N).toBe(0);
  });
});

describe('Z80 — OUT (C),r (ED prefix)', () => {
  it('OUT (C),B writes B to port BC', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234; h.cpu.b = 0x12; h.cpu.c = 0x34;
    h.cpu.bc = 0x1234;
    h.cpu.b = 0xAB; // change after setting bc → BC = 0xAB34
    load(h.mem, 0, 0xED, 0x41); // OUT (C),B
    step(h);
    expect(h.portWrites[0]).toEqual({ port: 0xAB34, val: 0xAB });
  });

  it('OUT (C),A writes A to port BC', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234; h.cpu.a = 0x77;
    load(h.mem, 0, 0xED, 0x79); // OUT (C),A
    step(h);
    expect(h.portWrites[0]).toEqual({ port: 0x1234, val: 0x77 });
  });

  it('OUT (C),0 (undocumented y=6) writes 0 to port BC regardless of registers', () => {
    const h = newCpu();
    h.cpu.bc = 0x5678; h.cpu.a = 0xFF;
    load(h.mem, 0, 0xED, 0x71); // OUT (C),0
    step(h);
    expect(h.portWrites[0]).toEqual({ port: 0x5678, val: 0x00 });
  });
});

describe('Z80 — IN r,(C) — all target registers and flag behaviour', () => {
  it('IN C,(C) loads port value into C, using BC as port', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234;
    h.ports.set(0x1234, 0x55);
    load(h.mem, 0, 0xED, 0x48); // IN C,(C)
    step(h);
    expect(h.cpu.c).toBe(0x55);
  });

  it('IN D,(C) and IN E,(C) write to the correct register', () => {
    for (const { op, get } of [
      { op: 0xED50, get: (h: Harness) => h.cpu.d },
      { op: 0xED58, get: (h: Harness) => h.cpu.e },
    ]) {
      const h = newCpu();
      h.cpu.bc = 0x4000;
      h.ports.set(0x4000, 0xCC);
      const hi = (op >> 8) & 0xFF;
      const lo = op & 0xFF;
      load(h.mem, 0, hi, lo);
      step(h);
      expect(get(h)).toBe(0xCC);
    }
  });

  it('IN F,(C) (y=6) updates flags but no GPR is written', () => {
    const h = newCpu();
    h.cpu.bc = 0x8000;
    h.ports.set(0x8000, 0x40); // 0x40 = bit 6 set → Z clear, PV from parity
    h.cpu.d = 0xDD; // sentinel — must not change
    load(h.mem, 0, 0xED, 0x70); // IN F,(C)
    step(h);
    expect(h.cpu.d).toBe(0xDD); // no GPR written
    expect(h.cpu.f & F_Z).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_H).toBe(0);
  });

  it('IN A,(C) sets Z when port value is zero', () => {
    const h = newCpu();
    h.cpu.bc = 0x0200;
    h.ports.set(0x0200, 0x00);
    load(h.mem, 0, 0xED, 0x78); // IN A,(C)
    step(h);
    expect(h.cpu.a).toBe(0x00);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_H).toBe(0);
  });
});
