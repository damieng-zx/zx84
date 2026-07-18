import { disasmOne, stripMarkers, type DisasmLine } from '@/debug/z80/disasm.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import { signed8 } from '@/utils/signed.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';

type TraceMode = 'full' | 'portio' | 'zxtl';
type PortTally = Map<number, { count: number; pcs: Set<number>; vals: Set<number> }>;

/** Spectrum-specific trace collection and formatting. This deliberately holds a
 * concrete machine: port labels and memory-access context are hardware details. */
export class SpectrumTrace {
  active = false;
  mode: TraceMode = 'full';
  buffer: string[] = [];
  private loopPC = new Int32Array(1024).fill(-1);
  private loopHash = new Int32Array(1024);
  private loopAddr = -1;
  private loopCount = 0;
  private portTallyIn: PortTally | null = null;
  private portTallyOut: PortTally | null = null;
  private zxtlPrevPC = -1;
  private zxtlPrevLen = 0;

  constructor(private readonly s: Spectrum) {}

  disasmAt(pc: number): DisasmLine {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 8; i++) buf[i] = this.s.memory.readByte((pc + i) & 0xFFFF);
    return { ...disasmOne(buf, 0), addr: pc };
  }

  start(mode: TraceMode = 'full'): void {
    this.buffer = [];
    this.mode = mode;
    this.loopPC.fill(-1);
    this.loopHash.fill(0);
    this.loopAddr = -1;
    this.loopCount = 0;
    if (mode === 'portio') {
      this.portTallyIn = new Map();
      this.portTallyOut = new Map();
    }
    if (mode === 'zxtl') {
      this.zxtlPrevPC = -1;
      this.zxtlPrevLen = 0;
      this.buffer.push('ZXTL V0001, ZX84 Emulator, JUMPS ADDRESS CYCLES MEM4 DISASSEMBLY REGS');
      this.buffer.push('J   Cycle Addr. +0 +1 +2 +3 DISASSEMBLY          A  F  B  C  D  E  H  L  XH XL YH YL SP   PC   W  Z  I  R');
    }
    this.active = true;
  }

  stop(): string {
    this.active = false;
    if (this.mode === 'portio') return this.formatPortTally();
    if (this.mode === 'full' && this.loopCount > 0) this.buffer.push(`      ... loops back to ${hex16(this.loopAddr)} x${this.loopCount}`);
    return this.buffer.join('\n');
  }

  logPortAccess(dir: string, port: number, val: number): void {
    if (this.mode === 'portio') {
      const tally = dir === 'IN' ? this.portTallyIn! : this.portTallyOut!;
      let entry = tally.get(port);
      if (!entry) { entry = { count: 0, pcs: new Set(), vals: new Set() }; tally.set(port, entry); }
      entry.count++;
      if (entry.pcs.size < 32) entry.pcs.add(this.s.cpu.pc);
      if (entry.vals.size < 64) entry.vals.add(val);
      return;
    }
    if (this.buffer.length >= 500_000) this.active = false;
  }

  captureFull(): void {
    const cpu = this.s.cpu;
    const pc = cpu.pc;
    const slot = pc & 0x3FF;
    let hash = cpu.a;
    hash = Math.imul(hash, 31) + cpu.f | 0;
    hash = Math.imul(hash, 31) + cpu.bc | 0;
    hash = Math.imul(hash, 31) + cpu.de | 0;
    hash = Math.imul(hash, 31) + cpu.hl | 0;
    hash = Math.imul(hash, 31) + cpu.ix | 0;
    hash = Math.imul(hash, 31) + cpu.iy | 0;
    hash = Math.imul(hash, 31) + cpu.sp | 0;
    hash = Math.imul(hash, 31) + cpu.i | 0;
    if (this.loopPC[slot] === pc && this.loopHash[slot] === hash) {
      if (this.loopCount === 0) this.loopAddr = pc;
      this.loopCount++;
      return;
    }
    if (this.loopCount > 0) {
      this.buffer.push(`      ... loops back to ${hex16(this.loopAddr)} x${this.loopCount}`);
      this.loopCount = 0;
    }
    this.loopPC[slot] = pc;
    this.loopHash[slot] = hash;
    const line = this.disasmAt(pc);
    const ctx = this.traceCtx(pc);
    const text = `${hex16(pc)}  ${stripMarkers(line.text).padEnd(24)}`;
    this.buffer.push(ctx ? `${text} ${ctx}` : text);
    if (this.buffer.length >= 500_000) this.active = false;
  }

  captureZxtl(prePC: number): void {
    const cpu = this.s.cpu;
    const mem = this.s.memory;
    const dl = this.disasmAt(prePC);
    const isJump = this.zxtlPrevPC >= 0 && prePC !== ((this.zxtlPrevPC + this.zxtlPrevLen) & 0xFFFF);
    this.zxtlPrevPC = prePC;
    this.zxtlPrevLen = dl.length;
    this.buffer.push(
      `${isJump ? '*' : ' '} ${String(cpu.tStates).padStart(7)} ${String(prePC).padStart(5)} ` +
      `${hex8(mem.readByte(prePC))} ${hex8(mem.readByte((prePC + 1) & 0xFFFF))} ${hex8(mem.readByte((prePC + 2) & 0xFFFF))} ${hex8(mem.readByte((prePC + 3) & 0xFFFF))} ` +
      `${stripMarkers(dl.text).padEnd(20)} ${hex8(cpu.a)} ${hex8(cpu.f)} ` +
      `${hex8(cpu.bc >> 8)} ${hex8(cpu.bc)} ${hex8(cpu.de >> 8)} ${hex8(cpu.de)} ${hex8(cpu.hl >> 8)} ${hex8(cpu.hl)} ` +
      `${hex8(cpu.ix >> 8)} ${hex8(cpu.ix)} ${hex8(cpu.iy >> 8)} ${hex8(cpu.iy)} ${hex16(cpu.sp)} ${hex16(cpu.pc)} ` +
      `${hex8(cpu.memptr >> 8)} ${hex8(cpu.memptr)} ${hex8(cpu.i)} ${hex8(cpu.r)}`,
    );
    if (this.buffer.length >= 500_000) this.active = false;
  }

  private traceCtx(pc: number): string {
    const cpu = this.s.cpu;
    const mem = this.s.memory;
    const op = mem.readByte(pc);
    if (op === 0xDD || op === 0xFD) {
      const ixr = op === 0xDD ? cpu.ix : cpu.iy;
      const op2 = mem.readByte((pc + 1) & 0xFFFF);
      if (op2 === 0xCB) { const addr = (ixr + signed8(mem.readByte((pc + 2) & 0xFFFF))) & 0xFFFF; return `(${hex16(addr)})=${hex8(mem.readByte(addr))}`; }
      if (op2 === 0xED || op2 === 0xDD || op2 === 0xFD) return '';
      const x = op2 >> 6, y = (op2 >> 3) & 7, z = op2 & 7;
      if ((x === 1 && (y === 6 || z === 6) && !(y === 6 && z === 6)) || (x === 2 && z === 6) || (x === 0 && (z === 4 || z === 5) && y === 6) || op2 === 0x36) {
        const addr = (ixr + signed8(mem.readByte((pc + 2) & 0xFFFF))) & 0xFFFF;
        return x === 2 ? `A=${hex8(cpu.a)} (${hex16(addr)})=${hex8(mem.readByte(addr))}` : `(${hex16(addr)})=${hex8(mem.readByte(addr))}`;
      }
      return '';
    }
    if (op === 0xCB) return (mem.readByte((pc + 1) & 0xFFFF) & 7) === 6 ? `(${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl))}` : '';
    if (op === 0xED) {
      const ed = mem.readByte((pc + 1) & 0xFFFF), x = ed >> 6, y = (ed >> 3) & 7, z = ed & 7;
      if (x === 1 && (z === 0 || z === 1)) return `port=${hex16(cpu.bc)}`;
      return x === 2 && y >= 4 && z < 4 ? `HL=${hex16(cpu.hl)} DE=${hex16(cpu.de)} BC=${hex16(cpu.bc)}` : '';
    }
    const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
    if (x === 0) {
      if (z === 0 && y === 2) return `B=${hex8(cpu.bc >> 8)}`;
      if (z === 0 && y >= 4) return cpu.checkCondition(y - 4) ? 'taken' : '--';
      if (z === 2) {
        if (q === 0 && p <= 1) return `A=${hex8(cpu.a)}→(${hex16(p === 0 ? cpu.bc : cpu.de)})`;
        if (q === 1 && p <= 1) { const addr = p === 0 ? cpu.bc : cpu.de; return `(${hex16(addr)})=${hex8(mem.readByte(addr))}`; }
      }
      if ((z === 4 || z === 5) && y === 6) return `(${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl))}`;
    }
    if (x === 1) {
      if (y === 6 && z !== 6) return `${hex8(cpu.getReg8(z))}→(${hex16(cpu.hl)})`;
      if (z === 6 && y !== 6) return `(${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl))}`;
    }
    if (x === 2) return z === 6 ? `A=${hex8(cpu.a)} (${hex16(cpu.hl)})=${hex8(mem.readByte(cpu.hl))}` : `A=${hex8(cpu.a)}`;
    if (x === 3) {
      if (z === 0 || z === 2 || z === 4) return cpu.checkCondition(y) ? 'taken' : '--';
      if (z === 6 || (z === 3 && y === 2)) return `A=${hex8(cpu.a)}`;
    }
    return '';
  }

  private portLabel(port: number): string {
    const v = this.s.variant;
    if ((port & 1) === 0) return 'ULA';
    if ((port & 0x00E0) === 0) return 'Kemp';
    if (v.hasAY && ((port & 0xC002) === 0xC000 || (port & 0xC002) === 0x8000)) return 'AY';
    if (v.decodes7FFD(port)) return '7FFD';
    if (v.decodes1FFD(port)) return '1FFD';
    if (v.decodesFDCStatus(port) || v.decodesFDCData(port)) return 'FDC';
    return '';
  }

  private formatPortTally(): string {
    const section = (title: string, tally: PortTally | null): string => {
      if (!tally?.size) return '';
      const lines = [`${title}:`];
      for (const [port, info] of [...tally.entries()].sort((a, b) => b[1].count - a[1].count)) {
        lines.push(`  ${hex16(port)}  ${String(info.count).padStart(8)}x  ${(this.portLabel(port) || '').padEnd(6)} from ${[...info.pcs].map(hex16).join(',')}  vals ${[...info.vals].map(hex8).join(',')}`);
      }
      return lines.join('\n');
    };
    const parts = ['=== Port IO Summary ===', ''];
    const input = section('IN', this.portTallyIn);
    const output = section('OUT', this.portTallyOut);
    if (input) parts.push(input, '');
    if (output) parts.push(output, '');
    this.portTallyIn = null;
    this.portTallyOut = null;
    return parts.join('\n');
  }
}
