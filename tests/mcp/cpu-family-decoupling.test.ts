/**
 * The MCP debug surface must be CPU-family-blind.
 *
 * Every host-side tool that prints or pokes CPU state goes through
 * `machine.services.debug` — never through a Z80 import — so that adding a
 * second CPU family (`src/debug/m6502/` for a BBC/C64) is a machine-folder job
 * with no edits under `mcp/`. These tests drive the trap system and the shared
 * formatters with a fabricated NON-Z80 debug service: if anything in `mcp/`
 * reaches for a Z80 register, disassembler or RET, it fails here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  installTrapHook, traps, trapLog, setResetTrap, consumeResetHit, type Trap,
} from '../../mcp/traps.ts';
import { formatStep, formatRegs } from '../../mcp/format.ts';
import type { DebugService, Machine } from '../../src/machines/machine.ts';

/** A plausible 6502-shaped debug service — no Z80 register anywhere. */
function makeDebugService() {
  const regs = { A: 0x12, X: 0x34, Y: 0x56, SP: 0x01F8, PC: 0xE000 };
  return {
    cpuFamily: 'm6502',
    pc: 0xE000,
    tStates: 4242,
    ports: null,
    regs: () => ({
      pc: regs.PC, sp: regs.SP, tStates: 4242, im: 0, iff1: true, halted: false,
      flags: [{ name: 'N', set: false }, { name: 'Z', set: true }],
      regs: [
        { name: 'A', width: 8 as const, value: regs.A },
        { name: 'X', width: 8 as const, value: regs.X },
        { name: 'Y', width: 8 as const, value: regs.Y },
      ],
    }),
    getReg: vi.fn((name: string) => (name in regs ? regs[name as keyof typeof regs] : null)),
    setReg: vi.fn((name: string, value: number) => {
      if (!(name in regs)) return false;
      regs[name as keyof typeof regs] = value;
      return true;
    }),
    disasm: (addr: number) => [
      { addr, bytes: '4C 00 E0', text: 'JMP $E000', length: 3, isTerminal: true },
    ],
    stepLine: () => 'E000  JMP $E000  A=12 X=34 Y=56  T=4242',
    regsText: () => 'A=12 X=34 Y=56',
    regsSummary: () => 'A=12 X=34 Y=56',
    returnStack: (depth: number) => Array.from({ length: depth }, (_, i) => 0xC000 + i),
    returnFromCall: vi.fn(),
  };
}

function makeSpec() {
  const debug = makeDebugService();
  const spec = {
    descriptor: { cpuFamily: 'm6502' },
    memory: { readByte: () => 0x00 },
    services: { debug: debug as unknown as DebugService },
  } as unknown as Machine;
  installTrapHook(spec);
  return { spec, debug };
}

function trap(over: Partial<Trap>): Trap {
  const t: Trap = { address: 0x8000, action: 'log', label: 'test', responses: [], ...over };
  traps.set(t.address, [t]);
  return t;
}

beforeEach(() => {
  traps.clear();
  trapLog.length = 0;
  setResetTrap(false);
});

describe('shared formatters delegate to the CPU family', () => {
  it('formatStep prints the service line verbatim — no Z80 register assembly', () => {
    const { spec } = makeSpec();
    expect(formatStep(spec)).toBe('E000  JMP $E000  A=12 X=34 Y=56  T=4242');
  });

  it('formatRegs prints the service block, not an AF/BC/HL layout', () => {
    const { spec } = makeSpec();
    const out = formatRegs(spec);
    expect(out).toBe('A=12 X=34 Y=56');
    expect(out).not.toMatch(/AF|HL|IX|IY/);
  });
});

describe('traps run on the debug service alone', () => {
  it('logs a hit with the family register summary', () => {
    const { spec } = makeSpec();
    trap({});
    expect(spec.onTrap!(0x8000)).toBe(false);
    expect(trapLog).toHaveLength(1);
    expect(trapLog[0]).toBe('[E000] test  A=12 X=34 Y=56 T=4242');
  });

  it('gates on a named register through getReg, not the Z80 C register', () => {
    const { spec, debug } = makeSpec();
    trap({ cond: { reg: 'X', value: 0x34 } });
    expect(spec.onTrap!(0x8000)).toBe(false);
    expect(debug.getReg).toHaveBeenCalledWith('X');
    expect(trapLog).toHaveLength(1);

    trapLog.length = 0;
    traps.clear();
    trap({ cond: { reg: 'X', value: 0x99 } });
    expect(spec.onTrap!(0x8000)).toBe(false);
    expect(trapLog).toHaveLength(0); // condition not met: no log, no break
  });

  it('a register the family does not have simply never matches', () => {
    const { spec } = makeSpec();
    trap({ cond: { reg: 'HL', value: 0 } });
    expect(spec.onTrap!(0x8000)).toBe(false);
    expect(trapLog).toHaveLength(0);
  });

  it('respond mode pokes through setReg and returns through the family RET', () => {
    const { spec, debug } = makeSpec();
    trap({ action: 'respond', responses: [{ regs: { A: 0x00, Y: 0x7F } }] });

    expect(spec.onTrap!(0x8000)).toBe(false);
    expect(debug.setReg).toHaveBeenCalledWith('A', 0x00);
    expect(debug.setReg).toHaveBeenCalledWith('Y', 0x7F);
    expect(debug.returnFromCall).toHaveBeenCalledTimes(1);
    expect(trapLog[0]).toContain('[RESPOND');
  });

  it('an empty respond queue breaks instead of returning', () => {
    const { spec, debug } = makeSpec();
    trap({ action: 'respond', responses: [] });
    expect(spec.onTrap!(0x8000)).toBe(true);
    expect(debug.returnFromCall).not.toHaveBeenCalled();
  });
});

describe('the reset trap reads the stack through the service', () => {
  it('captures the culprit disassembly and the family return stack', () => {
    const { spec } = makeSpec();
    setResetTrap(true);

    expect(spec.onTrap!(0xE003)).toBe(false); // establishes lastPc
    expect(spec.onTrap!(0x0000)).toBe(true);  // reboot

    const hit = consumeResetHit();
    expect(hit).not.toBeNull();
    expect(hit!.culpritPc).toBe(0xE003);
    expect(hit!.text).toContain('E003  JMP $E000');
    expect(hit!.text).toContain('SP=01F8');
    expect(hit!.text).toContain('stack: C000 C001');
    expect(hit!.text).toContain('T=4242');
  });
});
