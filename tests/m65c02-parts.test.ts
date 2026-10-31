/**
 * The 65C02 silicon variants: the Rockwell R65C02 (the Apple //c's CPU) adds
 * RMB/SMB at $x7 and BBR/BBS at $xF; the WDC W65C02S adds WAI ($CB) and STP
 * ($DB) as well. On a part without an instruction its opcode is a NOP: on the
 * base 65C02 (G65SC02, Synertek SY65C02) $x7 and $xF are one-byte, one-cycle
 * ones, and so are $CB and $DB on the base and Rockwell parts.
 *
 * Expectations are the Rockwell and WDC datasheets' (the instruction set and
 * cycle counts: 5 for RMB/SMB, 5 for BBR/BBS plus one when the branch is taken
 * and another if it crosses a page, 3 for WAI and STP), worked out by hand.
 */

import { describe, it, expect } from 'vitest';
import { FLAG_C, FLAG_I, FLAG_N, FLAG_V, FLAG_Z } from '@/cores/m6502.ts';
import { M65C02, type M65C02Part } from '@/cores/m65c02.ts';
import { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import { disasmOne, stripMarkers } from '@/debug/m6502/disasm.ts';

function part(kind: M65C02Part) {
  const mem = new Uint8Array(0x10000);
  const cpu = new M65C02(kind);
  cpu.read = (a: number) => mem[a & 0xFFFF];
  cpu.write = (a: number, v: number) => { mem[a & 0xFFFF] = v & 0xFF; };
  return { cpu, mem };
}

function boot(mem: Uint8Array, cpu: M65C02, bytes: number[], org = 0x0300): void {
  for (let i = 0; i < bytes.length; i++) mem[org + i] = bytes[i];
  cpu.pc = org;
}

describe('r65c02 — RMB and SMB', () => {
  it('RMBn clears bit n of a zero-page byte, in 5 cycles, touching no flags', () => {
    for (let n = 0; n < 8; n++) {
      const { cpu, mem } = part('r65c02');
      mem[0x20] = 0xFF;
      const p = cpu.p | FLAG_N | FLAG_C;
      cpu.p = p;
      boot(mem, cpu, [0x07 | (n << 4), 0x20]);
      cpu.step();
      expect(mem[0x20], `RMB${n}`).toBe(0xFF & ~(1 << n));
      expect(cpu.pc).toBe(0x0302);
      expect(cpu.tStates).toBe(5);
      expect(cpu.p).toBe(p);
    }
  });

  it('SMBn sets bit n, in 5 cycles, touching no flags', () => {
    for (let n = 0; n < 8; n++) {
      const { cpu, mem } = part('r65c02');
      mem[0x20] = 0x00;
      const p = cpu.p | FLAG_Z;
      cpu.p = p;
      boot(mem, cpu, [0x87 | (n << 4), 0x20]);
      cpu.step();
      expect(mem[0x20], `SMB${n}`).toBe(1 << n);
      expect(cpu.pc).toBe(0x0302);
      expect(cpu.tStates).toBe(5);
      expect(cpu.p).toBe(p);
    }
  });

  it('leave the other bits alone', () => {
    const { cpu, mem } = part('r65c02');
    mem[0x20] = 0b1010_0101;
    boot(mem, cpu, [0x37, 0x20, 0xC7, 0x20]);     // RMB3, SMB4
    cpu.step();
    expect(mem[0x20]).toBe(0b1010_0101);          // bit 3 was already clear
    cpu.step();
    expect(mem[0x20]).toBe(0b1011_0101);
  });
});

describe('r65c02 — BBR and BBS', () => {
  it('BBRn branches when bit n is clear: 6 cycles taken, 5 not', () => {
    for (let n = 0; n < 8; n++) {
      const take = part('r65c02');
      take.mem[0x20] = 0xFF & ~(1 << n);
      boot(take.mem, take.cpu, [0x0F | (n << 4), 0x20, 0x10]);
      take.cpu.step();
      expect(take.cpu.pc, `BBR${n} taken`).toBe(0x0313);
      expect(take.cpu.tStates).toBe(6);

      const skip = part('r65c02');
      skip.mem[0x20] = 1 << n;
      boot(skip.mem, skip.cpu, [0x0F | (n << 4), 0x20, 0x10]);
      skip.cpu.step();
      expect(skip.cpu.pc, `BBR${n} not taken`).toBe(0x0303);
      expect(skip.cpu.tStates).toBe(5);
    }
  });

  it('BBSn branches when bit n is set', () => {
    for (let n = 0; n < 8; n++) {
      const take = part('r65c02');
      take.mem[0x20] = 1 << n;
      boot(take.mem, take.cpu, [0x8F | (n << 4), 0x20, 0x10]);
      take.cpu.step();
      expect(take.cpu.pc, `BBS${n} taken`).toBe(0x0313);
      expect(take.cpu.tStates).toBe(6);

      const skip = part('r65c02');
      skip.mem[0x20] = 0xFF & ~(1 << n);
      boot(skip.mem, skip.cpu, [0x8F | (n << 4), 0x20, 0x10]);
      skip.cpu.step();
      expect(skip.cpu.pc, `BBS${n} not taken`).toBe(0x0303);
      expect(skip.cpu.tStates).toBe(5);
    }
  });

  it('a taken branch across a page costs another cycle; the offset is signed, from the next instruction', () => {
    const fwd = part('r65c02');
    fwd.mem[0x20] = 0x01;
    boot(fwd.mem, fwd.cpu, [0x8F, 0x20, 0x10], 0x03F0);        // BBS0 $20,+16 from $03F3
    fwd.cpu.step();
    expect(fwd.cpu.pc).toBe(0x0403);
    expect(fwd.cpu.tStates).toBe(7);

    const back = part('r65c02');
    back.mem[0x20] = 0x00;
    boot(back.mem, back.cpu, [0x1F, 0x20, 0xFB], 0x0300);       // BBR1 $20,-5 from $0303
    back.cpu.step();
    expect(back.cpu.pc).toBe(0x02FE);                           // back into the page below
    expect(back.cpu.tStates).toBe(7);

    const near = part('r65c02');
    near.mem[0x20] = 0x00;
    boot(near.mem, near.cpu, [0x7F, 0x20, 0xFD], 0x0310);       // BBR7 $20,-3 from $0313
    near.cpu.step();
    expect(near.cpu.pc).toBe(0x0310);
    expect(near.cpu.tStates).toBe(6);
  });

  it('touch no flags and do not change the byte tested', () => {
    const { cpu, mem } = part('r65c02');
    mem[0x20] = 0x80;
    cpu.p = FLAG_N | FLAG_V | FLAG_C | FLAG_I | 0x20;
    const p = cpu.p;
    boot(mem, cpu, [0xFF, 0x20, 0x00]);
    cpu.step();
    expect(cpu.p).toBe(p);
    expect(mem[0x20]).toBe(0x80);
  });
});

describe('65C02 parts — who has what', () => {
  it('the base 65C02 (G65SC02, Synertek) runs every $x7 and $xF as a one-byte, one-cycle NOP', () => {
    for (let hi = 0; hi < 16; hi++) {
      for (const lo of [0x7, 0xF]) {
        const { cpu, mem } = part('g65sc02');
        mem[0x20] = 0xAA;
        const regs = [cpu.a, cpu.x, cpu.y, cpu.p];
        boot(mem, cpu, [(hi << 4) | lo, 0x20, 0x10]);
        cpu.step();
        expect(cpu.pc, `${hi.toString(16)}${lo.toString(16)}`).toBe(0x0301);
        expect(cpu.tStates).toBe(1);
        expect(mem[0x20]).toBe(0xAA);
        expect([cpu.a, cpu.x, cpu.y, cpu.p]).toEqual(regs);
      }
    }
  });

  it('only the WDC part has WAI and STP: on the others $CB and $DB are one-byte, one-cycle NOPs', () => {
    for (const kind of ['g65sc02', 'r65c02'] as const) {
      for (const op of [0xCB, 0xDB]) {
        const { cpu, mem } = part(kind);
        boot(mem, cpu, [op, 0xEA]);
        cpu.step();
        expect(cpu.pc).toBe(0x0301);
        expect(cpu.tStates).toBe(1);
        cpu.step();                                // not stopped: the next instruction runs
        expect(cpu.pc).toBe(0x0302);
      }
    }
  });

  it('the WDC part has the Rockwell bit instructions too', () => {
    const { cpu, mem } = part('w65c02s');
    mem[0x20] = 0x01;
    boot(mem, cpu, [0xB7, 0x20]);                  // SMB3 $20
    cpu.step();
    expect(mem[0x20]).toBe(0x09);
  });
});

describe('w65c02s — WAI and STP', () => {
  it('WAI takes 3 cycles, then the CPU idles a cycle at a time with nothing fetched', () => {
    const { cpu, mem } = part('w65c02s');
    boot(mem, cpu, [0xCB, 0xA9, 0x42]);            // WAI; LDA #$42
    cpu.step();
    expect(cpu.tStates).toBe(3);
    expect(cpu.pc).toBe(0x0301);
    for (let i = 0; i < 5; i++) cpu.step();
    expect(cpu.tStates).toBe(8);
    expect(cpu.pc).toBe(0x0301);
    expect(cpu.a).toBe(0);
  });

  it('an IRQ with I set wakes WAI without being taken: the next instruction runs', () => {
    const { cpu, mem } = part('w65c02s');
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x90;
    boot(mem, cpu, [0xCB, 0xA9, 0x42]);
    cpu.p |= FLAG_I;
    cpu.step();
    cpu.step();                                    // idle
    cpu.setIRQ(true);
    cpu.step();                                    // wakes and executes LDA #$42
    expect(cpu.a).toBe(0x42);
    expect(cpu.pc).toBe(0x0303);
  });

  it('an IRQ with I clear wakes WAI and is taken, returning to the instruction after it', () => {
    const { cpu, mem } = part('w65c02s');
    mem[0xFFFE] = 0x00; mem[0xFFFF] = 0x90;
    boot(mem, cpu, [0xCB, 0xA9, 0x42]);
    cpu.p &= ~FLAG_I;
    cpu.step();
    cpu.setIRQ(true);
    cpu.step();
    expect(cpu.pc).toBe(0x9000);
    expect(mem[0x01FD]).toBe(0x03);                // pushed return address $0301
    expect(mem[0x01FC]).toBe(0x01);
  });

  it('an NMI wakes WAI even with I set', () => {
    const { cpu, mem } = part('w65c02s');
    mem[0xFFFA] = 0x00; mem[0xFFFB] = 0x80;
    boot(mem, cpu, [0xCB, 0xEA]);
    cpu.p |= FLAG_I;
    cpu.step();
    cpu.nmi();
    cpu.step();
    expect(cpu.pc).toBe(0x8000);
  });

  it('STP stops the CPU for good: interrupts do not wake it, only a reset', () => {
    const { cpu, mem } = part('w65c02s');
    mem[0xFFFA] = 0x00; mem[0xFFFB] = 0x80;
    mem[0xFFFC] = 0x00; mem[0xFFFD] = 0x04;
    boot(mem, cpu, [0xDB, 0xA9, 0x42]);
    cpu.p &= ~FLAG_I;
    cpu.step();
    expect(cpu.tStates).toBe(3);
    cpu.setIRQ(true);
    cpu.nmi();
    for (let i = 0; i < 4; i++) cpu.step();
    expect(cpu.pc).toBe(0x0301);
    expect(cpu.tStates).toBe(7);
    cpu.setIRQ(false);
    cpu.reset();
    expect(cpu.pc).toBe(0x0400);
    boot(mem, cpu, [0xA9, 0x42]);
    cpu.step();
    expect(cpu.a).toBe(0x42);
  });

  it('a snapshot carries the waiting state', () => {
    const { cpu, mem } = part('w65c02s');
    boot(mem, cpu, [0xCB, 0xA9, 0x42]);
    cpu.step();
    const w = new StateWriter();
    cpu.saveState(w);
    const copy = part('w65c02s');
    copy.mem.set(mem);
    copy.cpu.loadState(new StateReader(w.finish()));
    copy.cpu.step();
    expect(copy.cpu.pc).toBe(0x0301);              // still waiting, not executing $0301
    expect(copy.cpu.tStates).toBe(cpu.tStates + 1);
  });
});

describe('the disassembler knows each part', () => {
  it('names the Rockwell and WDC additions only on those parts', () => {
    const mem = new Uint8Array([0x37, 0x12, 0x8F, 0x20, 0x04, 0xCB, 0xDB]);
    const text = (isa: boolean | M65C02Part, at: number): string => stripMarkers(disasmOne(mem, at, isa).text);
    expect(text('r65c02', 0)).toBe('RMB3 12');
    expect(text('r65c02', 2)).toBe('BBS0 20,0009');
    expect(disasmOne(mem, 2, 'r65c02').length).toBe(3);
    expect(text('r65c02', 5)).toBe('NOP');
    expect(text('w65c02s', 5)).toBe('WAI');
    expect(text('w65c02s', 6)).toBe('STP');
    expect(text(true, 0)).toBe('NOP');
    expect(disasmOne(mem, 2, true).length).toBe(1);
  });
});
