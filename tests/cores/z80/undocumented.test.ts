/**
 * Z80 undocumented instruction coverage.
 *
 * References:
 *  - Sean Young, "The Undocumented Z80 Documented" v0.91 (2005), §§4–6
 *  - Patrik Rak, "MEMPTR, esoteric register of the Z80 CPU" (2013)
 *  - Yaze 'unof.c' opcode listing
 *
 * Behaviour-first: each test asserts what real silicon does. If the
 * implementation disagrees, the comment explains why and what the right
 * answer is.
 */

import { describe, it, expect } from 'vitest';
import { Z80 } from '@/cores/z80.ts';

const F_S  = 0x80;
const F_Z  = 0x40;
const F_F5 = 0x20;
const F_H  = 0x10;
const F_F3 = 0x08;
const F_PV = 0x04;
const F_N  = 0x02;
const F_C  = 0x01;

interface Harness {
  cpu: Z80;
  mem: Uint8Array;
  ports: Map<number, number>;
  portReads: number[];
  portWrites: { port: number; val: number }[];
}

function newCpu(): Harness {
  const cpu = new Z80();
  const mem = new Uint8Array(0x10000);
  const ports = new Map<number, number>();
  const portReads: number[] = [];
  const portWrites: { port: number; val: number }[] = [];
  cpu.read8 = (a) => mem[a & 0xFFFF];
  cpu.write8 = (a, v) => { mem[a & 0xFFFF] = v & 0xFF; };
  cpu.portInHandler = (port) => { portReads.push(port); return ports.get(port & 0xFFFF) ?? 0xFF; };
  cpu.portOutHandler = (port, val) => { portWrites.push({ port, val }); ports.set(port & 0xFFFF, val & 0xFF); };
  cpu.pc = 0;
  cpu.sp = 0xFFFF;
  return { cpu, mem, ports, portReads, portWrites };
}

function load(mem: Uint8Array, addr: number, ...bytes: number[]): void {
  for (let i = 0; i < bytes.length; i++) mem[(addr + i) & 0xFFFF] = bytes[i] & 0xFF;
}

function step(h: Harness, n = 1): void {
  for (let i = 0; i < n; i++) h.cpu.step();
}

// ─────────────────────────────────────────────────────────────────────────
// IXH / IXL / IYH / IYL — undocumented half-index access
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — IXH / IXL access (DD prefix on H/L ops)', () => {
  it('DD 26 nn  →  LD IXH,n  (high byte set, low preserved)', () => {
    const h = newCpu();
    h.cpu.ix = 0x00AB;
    load(h.mem, 0, 0xDD, 0x26, 0x12); // LD IXH,$12
    step(h);
    expect(h.cpu.ix).toBe(0x12AB);
  });

  it('DD 2E nn  →  LD IXL,n  (low byte set, high preserved)', () => {
    const h = newCpu();
    h.cpu.ix = 0xAB00;
    load(h.mem, 0, 0xDD, 0x2E, 0x34); // LD IXL,$34
    step(h);
    expect(h.cpu.ix).toBe(0xAB34);
  });

  it('DD 24  →  INC IXH', () => {
    const h = newCpu();
    h.cpu.ix = 0x10FF;
    load(h.mem, 0, 0xDD, 0x24);
    step(h);
    expect(h.cpu.ix).toBe(0x11FF);
  });

  it('DD 25  →  DEC IXH affects S/Z/H/PV/N (not C)', () => {
    const h = newCpu();
    h.cpu.ix = 0x0100; h.cpu.f = F_C;
    load(h.mem, 0, 0xDD, 0x25);
    step(h);
    expect(h.cpu.ix).toBe(0x0000);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
    expect(h.cpu.f & F_C).toBe(F_C); // preserved
  });

  it('DD 2C  →  INC IXL', () => {
    const h = newCpu();
    h.cpu.ix = 0xFF00;
    load(h.mem, 0, 0xDD, 0x2C);
    step(h);
    expect(h.cpu.ix).toBe(0xFF01);
  });

  it('DD 84  →  ADD A,IXH', () => {
    const h = newCpu();
    h.cpu.a = 0x10; h.cpu.ix = 0x2000;
    load(h.mem, 0, 0xDD, 0x84); // ADD A,IXH
    step(h);
    expect(h.cpu.a).toBe(0x30);
  });

  it('DD 85  →  ADD A,IXL', () => {
    const h = newCpu();
    h.cpu.a = 0x10; h.cpu.ix = 0x0022;
    load(h.mem, 0, 0xDD, 0x85);
    step(h);
    expect(h.cpu.a).toBe(0x32);
  });

  it('DD BC  →  CP IXH (compare A with IXH)', () => {
    const h = newCpu();
    h.cpu.a = 0x42; h.cpu.ix = 0x4200;
    load(h.mem, 0, 0xDD, 0xBC);
    step(h);
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.f & F_N).toBe(F_N);
    expect(h.cpu.a).toBe(0x42); // unchanged
  });

  it('DD 44  →  LD B,IXH copies the high half of IX into B', () => {
    const h = newCpu();
    h.cpu.ix = 0xDEAD;
    load(h.mem, 0, 0xDD, 0x44);
    step(h);
    expect(h.cpu.b).toBe(0xDE);
  });

  it('DD 65  →  LD IXH,IXL (within the same index register)', () => {
    const h = newCpu();
    h.cpu.ix = 0x1234;
    load(h.mem, 0, 0xDD, 0x65); // LD IXH,IXL
    step(h);
    expect(h.cpu.ix).toBe(0x3434);
  });

  it('DD 6C  →  LD IXL,IXH', () => {
    const h = newCpu();
    h.cpu.ix = 0xAB00;
    load(h.mem, 0, 0xDD, 0x6C);
    step(h);
    expect(h.cpu.ix).toBe(0xABAB);
  });

  it('DD 60  →  LD IXH,B does NOT touch the regular H register', () => {
    const h = newCpu();
    h.cpu.b = 0x77; h.cpu.h = 0x99; h.cpu.l = 0x88;
    h.cpu.ix = 0x1234;
    load(h.mem, 0, 0xDD, 0x60);
    step(h);
    expect(h.cpu.ix).toBe(0x7734);
    expect(h.cpu.h).toBe(0x99); // untouched
    expect(h.cpu.l).toBe(0x88);
  });
});

describe('Z80 — IYH / IYL access (FD prefix on H/L ops)', () => {
  it('FD 26 nn  →  LD IYH,n', () => {
    const h = newCpu();
    h.cpu.iy = 0x00CD;
    load(h.mem, 0, 0xFD, 0x26, 0x56);
    step(h);
    expect(h.cpu.iy).toBe(0x56CD);
  });

  it('FD 95  →  SUB IYL', () => {
    const h = newCpu();
    h.cpu.a = 0x50; h.cpu.iy = 0x0010;
    load(h.mem, 0, 0xFD, 0x95);
    step(h);
    expect(h.cpu.a).toBe(0x40);
    expect(h.cpu.f & F_N).toBe(F_N);
  });

  it('FD 7C  →  LD A,IYH', () => {
    const h = newCpu();
    h.cpu.iy = 0xC0DE;
    load(h.mem, 0, 0xFD, 0x7C);
    step(h);
    expect(h.cpu.a).toBe(0xC0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DDCB / FDCB — indexed CB ops with simultaneous register store
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DDCB indexed CB with register copy', () => {
  it('DD CB d 00  →  RLC (IX+d), B  (B also receives the result)', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC005] = 0x81;
    load(h.mem, 0, 0xDD, 0xCB, 0x05, 0x00); // RLC (IX+5),B
    step(h);
    expect(h.mem[0xC005]).toBe(0x03);
    expect(h.cpu.b).toBe(0x03);        // documented quirk: result copied to B
    expect(h.cpu.f & F_C).toBe(F_C);
  });

  it('DD CB d 06  →  RLC (IX+d) with NO register copy (z=6 is the standard form)', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000; h.cpu.b = 0xAA;
    h.mem[0xC000] = 0x40;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0x06); // RLC (IX+0)
    step(h);
    expect(h.mem[0xC000]).toBe(0x80);
    expect(h.cpu.b).toBe(0xAA); // unchanged
  });

  it('DD CB d C0  →  SET 0,(IX+d), B  (B also receives the stored byte)', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC001] = 0x00;
    load(h.mem, 0, 0xDD, 0xCB, 0x01, 0xC0); // SET 0,(IX+1),B
    step(h);
    expect(h.mem[0xC001]).toBe(0x01);
    expect(h.cpu.b).toBe(0x01);
  });

  it('DD CB d 80  →  RES 0,(IX+d), B copies the post-RES byte to B', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0xFF;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0x80); // RES 0,(IX+0),B
    step(h);
    expect(h.mem[0xC000]).toBe(0xFE);
    expect(h.cpu.b).toBe(0xFE);
  });

  it('DD CB d 36  →  SLL (IX+d) (undocumented shift, no register copy)', () => {
    const h = newCpu();
    h.cpu.ix = 0xC000;
    h.mem[0xC000] = 0x40;
    load(h.mem, 0, 0xDD, 0xCB, 0x00, 0x36); // SLL (IX+0)
    step(h);
    expect(h.mem[0xC000]).toBe(0x81); // bit 0 forced to 1
  });

  it('FD CB d 21  →  SLA (IY+d), C  copies result to C', () => {
    const h = newCpu();
    h.cpu.iy = 0xC100;
    h.mem[0xC100] = 0x42;
    load(h.mem, 0, 0xFD, 0xCB, 0x00, 0x21);
    step(h);
    expect(h.mem[0xC100]).toBe(0x84);
    expect(h.cpu.c).toBe(0x84);
  });

  it('signed displacement: DD CB FE 06  →  RLC (IX-2)', () => {
    const h = newCpu();
    h.cpu.ix = 0xC010;
    h.mem[0xC00E] = 0x81;
    load(h.mem, 0, 0xDD, 0xCB, 0xFE, 0x06); // RLC (IX-2)
    step(h);
    expect(h.mem[0xC00E]).toBe(0x03);
  });
});

describe('Z80 — DDCB BIT (n,(IX+d)) takes F3/F5 from MEMPTR high byte', () => {
  it('After BIT 0,(IX+5), F3 and F5 come from high byte of (IX+5)', () => {
    const h = newCpu();
    h.cpu.ix = 0x2820; // (IX+5) = 0x2825, high byte 0x28 → both F3 and F5 set
    h.mem[0x2825] = 0x01;
    load(h.mem, 0, 0xDD, 0xCB, 0x05, 0x46); // BIT 0,(IX+5)
    step(h);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_Z).toBe(0); // bit 0 is set
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ED undocumented entries
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — ED IM mirrors', () => {
  it('ED 4E selects IM 0 (mirror of ED 46)', () => {
    const h = newCpu();
    load(h.mem, 0, 0xED, 0x4E);
    step(h);
    expect(h.cpu.im).toBe(0);
  });

  it('ED 6E also selects IM 0', () => {
    const h = newCpu();
    h.cpu.im = 2;
    load(h.mem, 0, 0xED, 0x6E);
    step(h);
    expect(h.cpu.im).toBe(0);
  });

  it('ED 76 selects IM 1 (mirror of ED 56)', () => {
    const h = newCpu();
    load(h.mem, 0, 0xED, 0x76);
    step(h);
    expect(h.cpu.im).toBe(1);
  });

  it('ED 7E selects IM 2 (mirror of ED 5E)', () => {
    const h = newCpu();
    load(h.mem, 0, 0xED, 0x7E);
    step(h);
    expect(h.cpu.im).toBe(2);
  });
});

describe('Z80 — ED 70: IN F,(C) — reads, discards into flags only', () => {
  it('flags updated from the input byte; no GPR clobbered', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234;
    h.ports.set(0x1234, 0x80);
    h.cpu.b = 0x12; h.cpu.c = 0x34;
    h.cpu.d = 0xAA; h.cpu.e = 0xBB; h.cpu.h = 0xCC; h.cpu.l = 0xDD;
    const aBefore = h.cpu.a;
    load(h.mem, 0, 0xED, 0x70);
    step(h);
    expect(h.cpu.a).toBe(aBefore);     // no destination register
    expect(h.cpu.b).toBe(0x12);         // none of the GPRs change
    expect(h.cpu.c).toBe(0x34);
    expect(h.cpu.d).toBe(0xAA); expect(h.cpu.e).toBe(0xBB);
    expect(h.cpu.h).toBe(0xCC); expect(h.cpu.l).toBe(0xDD);
    expect(h.cpu.f & F_S).toBe(F_S);    // bit 7 set in input
    expect(h.cpu.f & F_Z).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
  });
});

describe('Z80 — IN r,(C) masks a misbehaving port handler\'s return value', () => {
  // The data bus is 8 bits; a handler returning something outside 0-255 must
  // not corrupt the destination register or the SZP flags-table lookup (an
  // out-of-range index there used to silently zero S/Z/H/PV/F3/F5 instead of
  // computing them from the low 8 bits — see Z80.portIn).
  it('IN r,(C): destination register and flags come from the low 8 bits only', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234;
    h.ports.set(0x1234, 0x1A5); // out-of-range: low byte is 0xA5 (bit 7 set)
    load(h.mem, 0, 0xED, 0x50); // IN D,(C)
    step(h);
    expect(h.cpu.d).toBe(0xA5);
    // SZP[0xA5], not the out-of-bounds SZP[0x1A5] (which would read as
    // undefined and silently zero every flag but carry).
    expect(h.cpu.f & F_S).toBe(F_S);
    expect(h.cpu.f & F_Z).toBe(0);
  });

  it('IN F,(C): flags come from the low 8 bits only', () => {
    const h = newCpu();
    h.cpu.bc = 0x1234;
    h.ports.set(0x1234, 0x180); // out-of-range: low byte is 0x80 (bit 7 set)
    load(h.mem, 0, 0xED, 0x70); // IN F,(C)
    step(h);
    expect(h.cpu.f & F_S).toBe(F_S); // SZP[0x80], not SZP[0x180]
  });
});

describe('Z80 — ED 71: OUT (C),0 — NMOS Z80 writes 0', () => {
  it('writes the byte 0 to port BC, regardless of any register', () => {
    const h = newCpu();
    h.cpu.bc = 0xABCD;
    h.cpu.a = 0x99;
    load(h.mem, 0, 0xED, 0x71);
    step(h);
    expect(h.portWrites[0]).toEqual({ port: 0xABCD, val: 0 });
    // Note: CMOS Z80 (Z84C00 etc.) outputs 0xFF instead. We model NMOS.
  });
});

describe('Z80 — ED unallocated entries behave as 8T NOPs', () => {
  // Picked a few from the documented "no operation" ranges:
  //  ED 00..3F (except ED 00 if trapHandler is wired), ED 80..9F,
  //  ED A4..AF (the few non-block ones), ED B4..BF, ED C0..FF
  const slots = [0x77, 0x7F, 0x9F, 0xBF, 0xCC, 0xFF];

  it.each(slots)('ED 0x%s advances PC by 2 and leaves registers untouched', (op) => {
    const h = newCpu();
    h.cpu.a = 0x42; h.cpu.bc = 0xBEEF; h.cpu.hl = 0xABCD;
    h.cpu.f = F_C | F_Z;
    load(h.mem, 0, 0xED, op);
    step(h);
    expect(h.cpu.pc).toBe(2);
    expect(h.cpu.a).toBe(0x42);
    expect(h.cpu.bc).toBe(0xBEEF);
    expect(h.cpu.hl).toBe(0xABCD);
    expect(h.cpu.f).toBe(F_C | F_Z);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// BIT n,(HL) — undocumented MEMPTR high byte leak
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — BIT n,(HL) takes F3/F5 from MEMPTR high byte (not value)', () => {
  it('After an op that loads MEMPTR with $2840, BIT n,(HL) shows F3=1 F5=1', () => {
    const h = newCpu();
    // LD A,($2840)  — sets MEMPTR = $2841.  MEMPTR high byte = $28 → F3, F5 both set.
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0xFF;       // value at (HL) — bits 3 and 5 also set, so we'd
                                 // not be able to distinguish.  Use a value that has
                                 // bits 3 and 5 *clear* so the source is unambiguous.
    h.mem[0xC000] = 0x01;       // value with bits 3 and 5 clear
    h.mem[0x2840] = 0xAA;
    load(h.mem, 0,
      0x3A, 0x40, 0x28,         // LD A,($2840) — sets MEMPTR = $2841 (high = $28)
      0xCB, 0x46,               // BIT 0,(HL)
    );
    step(h, 2);
    // MEMPTR high byte = $28 → bits 3 and 5 set in F
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
    expect(h.cpu.f & F_H).toBe(F_H);
    expect(h.cpu.f & F_Z).toBe(0); // bit 0 IS set in 0x01
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DD DD / DD FD chains — prefix-on-prefix
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — DD/FD chained prefixes', () => {
  it('DD DD ... drops the first DD and the second DD takes effect', () => {
    // Each prefix byte consumes its own M1 cycle (4T) on real silicon and the
    // whole chain — every redundant prefix plus the final opcode — resolves
    // within a single step() call, matching hardware (no interrupt can be
    // accepted mid-chain). Total cost: 4T + 4T + 6T = 14T, R advances by 3,
    // and the inner INC targets IX, not HL.
    const h = newCpu();
    h.cpu.ix = 0x1000;
    load(h.mem, 0, 0xDD, 0xDD, 0x23); // DD DD 23 → effectively INC IX
    const rBefore = h.cpu.r;
    const before = h.cpu.tStates;
    step(h, 1);
    expect(h.cpu.ix).toBe(0x1001);
    expect(h.cpu.hl).toBe(0);
    expect(h.cpu.tStates - before).toBe(14);
    expect((h.cpu.r - rBefore) & 0x7F).toBe(3);
  });

  it('DD FD ... drops the DD and FD takes effect (so IY, not IX, is incremented)', () => {
    const h = newCpu();
    h.cpu.iy = 0x2000; h.cpu.ix = 0x1000;
    load(h.mem, 0, 0xDD, 0xFD, 0x23);
    step(h, 1);
    expect(h.cpu.iy).toBe(0x2001);
    expect(h.cpu.ix).toBe(0x1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// MEMPTR observable side effects
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — MEMPTR side effects (visible via BIT n,(HL))', () => {
  it('IN A,(n) sets MEMPTR low = port_low + 1, MEMPTR high = A before op', () => {
    const h = newCpu();
    h.cpu.a = 0x28;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x01;
    h.ports.set(0x2855, 0x00);
    load(h.mem, 0,
      0xDB, 0x55,    // IN A,($55)  → MEMPTR = ($28 << 8) | ($55+1) = $2856
      0xCB, 0x46,    // BIT 0,(HL)
    );
    step(h, 2);
    // MEMPTR high = $28 → F3=1 F5=1
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });

  it('OUT (n),A sets MEMPTR high = A; BIT n,(HL) sees it', () => {
    const h = newCpu();
    h.cpu.a = 0x28;
    h.cpu.hl = 0xC000;
    h.mem[0xC000] = 0x01;
    load(h.mem, 0,
      0xD3, 0x99,    // OUT ($99),A — MEMPTR high = A = $28
      0xCB, 0x46,    // BIT 0,(HL)
    );
    step(h, 2);
    expect(h.cpu.f & F_F3).toBe(F_F3);
    expect(h.cpu.f & F_F5).toBe(F_F5);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Block-op repeat semantics (LDIR / CPIR PC backtrack)
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — LDIR/CPIR repeat semantics', () => {
  it('LDIR backtracks PC by 2 on each iteration until BC=0', () => {
    const h = newCpu();
    h.cpu.hl = 0xC000; h.cpu.de = 0xC100; h.cpu.bc = 3;
    for (let i = 0; i < 3; i++) h.mem[0xC000 + i] = 0xA0 + i;
    load(h.mem, 0x10, 0xED, 0xB0);
    h.cpu.pc = 0x10;

    h.cpu.step();
    expect(h.cpu.pc).toBe(0x10); // still pointing at LDIR
    expect(h.cpu.bc).toBe(2);
    h.cpu.step();
    expect(h.cpu.pc).toBe(0x10);
    expect(h.cpu.bc).toBe(1);
    h.cpu.step();
    expect(h.cpu.pc).toBe(0x12); // BC now 0 → falls through
    expect(h.cpu.bc).toBe(0);
    expect(Array.from(h.mem.slice(0xC100, 0xC103))).toEqual([0xA0, 0xA1, 0xA2]);
  });

  it('CPIR halts early on a match (Z set) AND when BC reaches 0', () => {
    const h = newCpu();
    h.cpu.a = 0x42; h.cpu.hl = 0xC000; h.cpu.bc = 10;
    h.mem[0xC000] = 0x00; h.mem[0xC001] = 0x42; // match at HL+1
    load(h.mem, 0, 0xED, 0xB1);

    h.cpu.step();
    expect(h.cpu.pc).toBe(0); // no match yet (0x00 != 0x42), repeat
    h.cpu.step();
    expect(h.cpu.pc).toBe(2); // match → fall through
    expect(h.cpu.f & F_Z).toBe(F_Z);
    expect(h.cpu.bc).toBe(8); // 10 - 2
  });
});

// ─────────────────────────────────────────────────────────────────────────
// LD A,I / LD A,R — IFF2 → P/V flag leak
// ─────────────────────────────────────────────────────────────────────────

describe('Z80 — LD A,I / LD A,R copy IFF2 into P/V (documented)', () => {
  it('LD A,I: P/V reflects IFF2=1', () => {
    const h = newCpu();
    h.cpu.iff2 = true; h.cpu.i = 0x40;
    load(h.mem, 0, 0xED, 0x57);
    step(h);
    expect(h.cpu.a).toBe(0x40);
    expect(h.cpu.f & F_PV).toBe(F_PV);
  });

  it('LD A,R: P/V reflects IFF2=0', () => {
    const h = newCpu();
    h.cpu.iff2 = false;
    load(h.mem, 0, 0xED, 0x5F);
    step(h);
    expect(h.cpu.f & F_PV).toBe(0);
    expect(h.cpu.f & F_N).toBe(0);
    expect(h.cpu.f & F_H).toBe(0);
  });
});
