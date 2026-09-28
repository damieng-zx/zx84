/**
 * 6502 disassembler.
 *
 * Covers the official instruction set plus the stable undocumented opcodes
 * (SLO/RLA/SRE/RRA/SAX/LAX/DCP/ISC/ANC/ALR/ARR/AXS and the NOP family). The
 * unstable undocumented opcodes render as `???`.
 *
 * Mnemonic text uses marker bytes to tag operand types for colorized display,
 * matching the Z80 disassembler:
 *   \x01...\x01 = numeric value (blue)
 *   \x02...\x02 = memory/jump address (purple)
 */

import { hex8 as h8, hex16 as h16 } from '@/utils/hex.ts';
import { signed8 } from '@/utils/signed.ts';

export interface DisasmLine {
  addr: number;
  length: number;
  text: string;
  isTerminal: boolean;
}

type Mode =
  | 'imp' | 'acc' | 'imm'
  | 'zp' | 'zpx' | 'zpy'
  | 'abs' | 'abx' | 'aby'
  | 'ind' | 'inx' | 'iny' | 'rel';

function val(s: string): string { return `\x01${s}\x01`; }
function adr(s: string): string { return `\x02${s}\x02`; }

/** 256-entry opcode table: [mnemonic, addressing mode]. */
const OPS: readonly (readonly [string, Mode])[] = [
  ['BRK', 'imp'], ['ORA', 'inx'], ['???', 'imp'], ['SLO', 'inx'],
  ['NOP', 'zp'], ['ORA', 'zp'], ['ASL', 'zp'], ['SLO', 'zp'],
  ['PHP', 'imp'], ['ORA', 'imm'], ['ASL', 'acc'], ['ANC', 'imm'],
  ['NOP', 'abs'], ['ORA', 'abs'], ['ASL', 'abs'], ['SLO', 'abs'],
  ['BPL', 'rel'], ['ORA', 'iny'], ['???', 'imp'], ['SLO', 'iny'],
  ['NOP', 'zpx'], ['ORA', 'zpx'], ['ASL', 'zpx'], ['SLO', 'zpx'],
  ['CLC', 'imp'], ['ORA', 'aby'], ['NOP', 'imp'], ['SLO', 'aby'],
  ['NOP', 'abx'], ['ORA', 'abx'], ['ASL', 'abx'], ['SLO', 'abx'],
  ['JSR', 'abs'], ['AND', 'inx'], ['???', 'imp'], ['RLA', 'inx'],
  ['BIT', 'zp'], ['AND', 'zp'], ['ROL', 'zp'], ['RLA', 'zp'],
  ['PLP', 'imp'], ['AND', 'imm'], ['ROL', 'acc'], ['ANC', 'imm'],
  ['BIT', 'abs'], ['AND', 'abs'], ['ROL', 'abs'], ['RLA', 'abs'],
  ['BMI', 'rel'], ['AND', 'iny'], ['???', 'imp'], ['RLA', 'iny'],
  ['NOP', 'zpx'], ['AND', 'zpx'], ['ROL', 'zpx'], ['RLA', 'zpx'],
  ['SEC', 'imp'], ['AND', 'aby'], ['NOP', 'imp'], ['RLA', 'aby'],
  ['NOP', 'abx'], ['AND', 'abx'], ['ROL', 'abx'], ['RLA', 'abx'],
  ['RTI', 'imp'], ['EOR', 'inx'], ['???', 'imp'], ['SRE', 'inx'],
  ['NOP', 'zp'], ['EOR', 'zp'], ['LSR', 'zp'], ['SRE', 'zp'],
  ['PHA', 'imp'], ['EOR', 'imm'], ['LSR', 'acc'], ['ALR', 'imm'],
  ['JMP', 'abs'], ['EOR', 'abs'], ['LSR', 'abs'], ['SRE', 'abs'],
  ['BVC', 'rel'], ['EOR', 'iny'], ['???', 'imp'], ['SRE', 'iny'],
  ['NOP', 'zpx'], ['EOR', 'zpx'], ['LSR', 'zpx'], ['SRE', 'zpx'],
  ['CLI', 'imp'], ['EOR', 'aby'], ['NOP', 'imp'], ['SRE', 'aby'],
  ['NOP', 'abx'], ['EOR', 'abx'], ['LSR', 'abx'], ['SRE', 'abx'],
  ['RTS', 'imp'], ['ADC', 'inx'], ['???', 'imp'], ['RRA', 'inx'],
  ['NOP', 'zp'], ['ADC', 'zp'], ['ROR', 'zp'], ['RRA', 'zp'],
  ['PLA', 'imp'], ['ADC', 'imm'], ['ROR', 'acc'], ['ARR', 'imm'],
  ['JMP', 'ind'], ['ADC', 'abs'], ['ROR', 'abs'], ['RRA', 'abs'],
  ['BVS', 'rel'], ['ADC', 'iny'], ['???', 'imp'], ['RRA', 'iny'],
  ['NOP', 'zpx'], ['ADC', 'zpx'], ['ROR', 'zpx'], ['RRA', 'zpx'],
  ['SEI', 'imp'], ['ADC', 'aby'], ['NOP', 'imp'], ['RRA', 'aby'],
  ['NOP', 'abx'], ['ADC', 'abx'], ['ROR', 'abx'], ['RRA', 'abx'],
  ['NOP', 'imm'], ['STA', 'inx'], ['NOP', 'imm'], ['SAX', 'inx'],
  ['STY', 'zp'], ['STA', 'zp'], ['STX', 'zp'], ['SAX', 'zp'],
  ['DEY', 'imp'], ['NOP', 'imm'], ['TXA', 'imp'], ['XAA', 'imm'],
  ['STY', 'abs'], ['STA', 'abs'], ['STX', 'abs'], ['SAX', 'abs'],
  ['BCC', 'rel'], ['STA', 'iny'], ['???', 'imp'], ['SHA', 'iny'],
  ['STY', 'zpx'], ['STA', 'zpx'], ['STX', 'zpy'], ['SAX', 'zpy'],
  ['TYA', 'imp'], ['STA', 'aby'], ['TXS', 'imp'], ['TAS', 'aby'],
  ['SHY', 'abx'], ['STA', 'abx'], ['SHX', 'aby'], ['SHA', 'aby'],
  ['LDY', 'imm'], ['LDA', 'inx'], ['LDX', 'imm'], ['LAX', 'inx'],
  ['LDY', 'zp'], ['LDA', 'zp'], ['LDX', 'zp'], ['LAX', 'zp'],
  ['TAY', 'imp'], ['LDA', 'imm'], ['TAX', 'imp'], ['LXA', 'imm'],
  ['LDY', 'abs'], ['LDA', 'abs'], ['LDX', 'abs'], ['LAX', 'abs'],
  ['BCS', 'rel'], ['LDA', 'iny'], ['???', 'imp'], ['LAX', 'iny'],
  ['LDY', 'zpx'], ['LDA', 'zpx'], ['LDX', 'zpy'], ['LAX', 'zpy'],
  ['CLV', 'imp'], ['LDA', 'aby'], ['TSX', 'imp'], ['LAS', 'aby'],
  ['LDY', 'abx'], ['LDA', 'abx'], ['LDX', 'aby'], ['LAX', 'aby'],
  ['CPY', 'imm'], ['CMP', 'inx'], ['NOP', 'imm'], ['DCP', 'inx'],
  ['CPY', 'zp'], ['CMP', 'zp'], ['DEC', 'zp'], ['DCP', 'zp'],
  ['INY', 'imp'], ['CMP', 'imm'], ['DEX', 'imp'], ['AXS', 'imm'],
  ['CPY', 'abs'], ['CMP', 'abs'], ['DEC', 'abs'], ['DCP', 'abs'],
  ['BNE', 'rel'], ['CMP', 'iny'], ['???', 'imp'], ['DCP', 'iny'],
  ['NOP', 'zpx'], ['CMP', 'zpx'], ['DEC', 'zpx'], ['DCP', 'zpx'],
  ['CLD', 'imp'], ['CMP', 'aby'], ['NOP', 'imp'], ['DCP', 'aby'],
  ['NOP', 'abx'], ['CMP', 'abx'], ['DEC', 'abx'], ['DCP', 'abx'],
  ['CPX', 'imm'], ['SBC', 'inx'], ['NOP', 'imm'], ['ISC', 'inx'],
  ['CPX', 'zp'], ['SBC', 'zp'], ['INC', 'zp'], ['ISC', 'zp'],
  ['INX', 'imp'], ['SBC', 'imm'], ['NOP', 'imp'], ['SBC', 'imm'],
  ['CPX', 'abs'], ['SBC', 'abs'], ['INC', 'abs'], ['ISC', 'abs'],
  ['BEQ', 'rel'], ['SBC', 'iny'], ['???', 'imp'], ['ISC', 'iny'],
  ['NOP', 'zpx'], ['SBC', 'zpx'], ['INC', 'zpx'], ['ISC', 'zpx'],
  ['SED', 'imp'], ['SBC', 'aby'], ['NOP', 'imp'], ['ISC', 'aby'],
  ['NOP', 'abx'], ['SBC', 'abx'], ['INC', 'abx'], ['ISC', 'abx'],
];

const TERMINAL = new Set(['JMP', 'RTS', 'RTI', 'BRK']);

export function disasmOne(mem: Uint8Array, addr: number): DisasmLine {
  const start = addr & 0xFFFF;
  let p = start;
  const rd = (): number => { const v = mem[p & 0xFFFF]; p = (p + 1) & 0xFFFF; return v; };
  const rd16 = (): number => { const lo = rd(); return lo | (rd() << 8); };

  const op = rd();
  const [mnem, mode] = OPS[op];
  let text: string;

  switch (mode) {
    case 'imp': text = mnem; break;
    case 'acc': text = `${mnem} A`; break;
    case 'imm': text = `${mnem} #${val(h8(rd()))}`; break;
    case 'zp': text = `${mnem} ${adr(h8(rd()))}`; break;
    case 'zpx': text = `${mnem} ${adr(h8(rd()))},X`; break;
    case 'zpy': text = `${mnem} ${adr(h8(rd()))},Y`; break;
    case 'abs': text = `${mnem} ${adr(h16(rd16()))}`; break;
    case 'abx': text = `${mnem} ${adr(h16(rd16()))},X`; break;
    case 'aby': text = `${mnem} ${adr(h16(rd16()))},Y`; break;
    case 'ind': text = `${mnem} (${adr(h16(rd16()))})`; break;
    case 'inx': text = `${mnem} (${adr(h8(rd()))},X)`; break;
    case 'iny': text = `${mnem} (${adr(h8(rd()))}),Y`; break;
    case 'rel': {
      const off = rd();
      const target = (p + signed8(off)) & 0xFFFF;
      text = `${mnem} ${adr(h16(target))}`;
      break;
    }
    default: text = '???';
  }

  return {
    addr: start,
    length: (p - start) & 0xFFFF,
    text,
    isTerminal: TERMINAL.has(mnem),
  };
}

export function disassemble(mem: Uint8Array, startAddr: number, maxLines = 24): DisasmLine[] {
  const lines: DisasmLine[] = [];
  let addr = startAddr & 0xFFFF;
  for (let i = 0; i < maxLines; i++) {
    const line = disasmOne(mem, addr);
    lines.push(line);
    addr = (addr + line.length) & 0xFFFF;
    if (line.isTerminal) break;
  }
  return lines;
}

/** 6502 instructions are 1–3 bytes; step back up to 2 bytes to land on PC. */
export function disassembleAroundPC(
  mem: Uint8Array, pc: number, totalLines = 24, before = 6,
): DisasmLine[] {
  for (let offset = 1; offset <= 2; offset++) {
    const start = (pc - offset) & 0xFFFF;
    const lines = disassemble(mem, start, totalLines + 4);
    const idx = lines.findIndex(l => l.addr === pc);
    if (idx >= 0 && idx <= before) {
      const targetIdx = Math.min(before, idx, Math.max(0, totalLines - 1));
      const startIdx = idx - targetIdx;
      return lines.slice(startIdx, startIdx + totalLines);
    }
  }
  return disassemble(mem, pc, totalLines);
}

function colorize(text: string): string {
  return text
    .replace(/\x01([^\x01]*)\x01/g, '<span class="d-val">$1</span>')
    .replace(/\x02([^\x02]*)\x02/g, '<span class="d-adr">$1</span>');
}

export function stripMarkers(text: string): string {
  return text.replace(/[\x01\x02]/g, '');
}

export function formatDisasmHtml(
  lines: DisasmLine[], mem: Uint8Array, pc: number,
  breakpoints?: Set<number>,
): string {
  return lines.map(l => {
    const cur = l.addr === pc;
    const bp = breakpoints?.has(l.addr);
    const cls = 'd-line' + (cur ? ' d-cur' : '') + (bp ? ' d-bp' : '');
    const bytes: string[] = [];
    for (let i = 0; i < l.length; i++) bytes.push(h8(mem[(l.addr + i) & 0xFFFF]));
    const bytesStr = bytes.join(' ').padEnd(11);
    return `<div class="${cls}" data-addr="${l.addr}"><span class="d-off">${h16(l.addr)}</span> <span class="d-hex">${bytesStr}</span> ${colorize(l.text)}</div>`;
  }).join('');
}
