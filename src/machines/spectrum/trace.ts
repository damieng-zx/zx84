import { Z80Trace } from '@/debug/z80/trace.ts';
import { hex16 } from '@/utils/hex.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';

/** The Spectrum's trace: the shared Z80 engine with the Spectrum's own line
 *  layout and port names. Its frame loop calls `captureFull` (RAM only) and
 *  `captureZxtl` itself, and its port decode feeds `logPortAccess`, so the
 *  engine's port tap is off. */
export class SpectrumTrace extends Z80Trace {
  constructor(private readonly s: Spectrum) {
    super(s, { tapPorts: false });
  }

  /** Address, disassembly and operand context — no register columns. */
  protected override fullLine(pc: number, text: string, ctx: string): string {
    const line = `${hex16(pc)}  ${text.padEnd(24)}`;
    return ctx ? `${line} ${ctx}` : line;
  }

  protected override portLabel(port: number): string {
    const v = this.s.variant;
    if ((port & 1) === 0) return 'ULA';
    if ((port & 0x00E0) === 0) return 'Kemp';
    if (v.hasAY && ((port & 0xC002) === 0xC000 || (port & 0xC002) === 0x8000)) return 'AY';
    if (v.decodes7FFD(port)) return '7FFD';
    if (v.decodes1FFD(port)) return '1FFD';
    if (v.decodesFDCStatus(port) || v.decodesFDCData(port)) return 'FDC';
    return '';
  }
}
