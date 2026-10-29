/**
 * The 64's chips as the debugger's `chip_state` shows them: the VIC-II, the
 * SID, both CIAs, the PLA's banking and, when one is fitted, the 1541.
 *
 * Every dump reads the chips' own state, never the bus, so taking one clears
 * no interrupt flag and trips no watchpoint (a CIA ICR read would).
 */

import type { ChipSection } from '@/debug/chip-state.ts';
import type { Mos6526 } from '@/cores/mos6526.ts';
import type { M6522 } from '@/cores/m6522.ts';
import { hex8, hex16 } from '@/utils/hex.ts';
import type { C64Machine } from './c64-machine.ts';
import { C64_CPU_CLOCK } from './constants.ts';

const bits = (v: number, names: readonly string[]): string => {
  const on = names.filter((_, i) => names[i] && (v & (1 << i)) !== 0);
  return on.length ? on.join(' ') : '-';
};

const hx = (v: number, w = 2): string => (w === 2 ? hex8(v) : hex16(v));
const bin8 = (v: number): string => (v & 0xFF).toString(2).padStart(8, '0');

// ── VIC-II ────────────────────────────────────────────────────────────────

const VIC_NAMES = [
  'M0X', 'M0Y', 'M1X', 'M1Y', 'M2X', 'M2Y', 'M3X', 'M3Y', 'M4X', 'M4Y', 'M5X', 'M5Y', 'M6X', 'M6Y', 'M7X', 'M7Y',
  'MSBX', 'CR1', 'RASTER', 'LPX', 'LPY', 'ME', 'CR2', 'MYE', 'MEMPTR', 'IRQ', 'IRQEN', 'MDP', 'MMC', 'MXE', 'MM', 'MD',
  'EC', 'B0C', 'B1C', 'B2C', 'B3C', 'MM0', 'MM1', 'M0C', 'M1C', 'M2C', 'M3C', 'M4C', 'M5C', 'M6C', 'M7C',
];

function dumpVic(m: C64Machine): string {
  const v = m.vic;
  const r = v.regs;
  const cr1 = r[0x11];
  const cr2 = r[0x16];
  const ecm = (cr1 & 0x40) !== 0;
  const bmm = (cr1 & 0x20) !== 0;
  const mcm = (cr2 & 0x10) !== 0;
  const mode = `${ecm ? 'ECM ' : ''}${bmm ? 'bitmap' : 'text'}${mcm ? ' multicolour' : ''}`;
  const bank = m.memory.vicBase;
  const memptr = r[0x18];
  const screen = bank | ((memptr & 0xF0) << 6);
  const chars = bank | ((memptr & 0x0E) << 10);
  const bitmap = bank | ((memptr & 0x08) << 10);
  const lines = [
    `RASTER  line ${v.raster}  compare ${v.rasterCompare}  ${v.badline ? 'bad line' : ''}`.trimEnd(),
    `CR1     D011 = ${hx(cr1)}  ${mode}, ${(cr1 & 0x10) ? 'display on' : 'display OFF'}, ${(cr1 & 8) ? 25 : 24} rows, YSCROLL ${cr1 & 7}`,
    `CR2     D016 = ${hx(cr2)}  ${(cr2 & 8) ? 40 : 38} columns, XSCROLL ${cr2 & 7}`,
    `MEMPTR  D018 = ${hx(memptr)}  bank ${bank >> 14} ($${hx(bank, 4)}), screen $${hx(screen, 4)}, ` +
      `${bmm ? `bitmap $${hx(bitmap, 4)}` : `characters $${hx(chars, 4)}`}`,
    `IRQ     D019 = ${hx(v.irqFlags | 0x70)}  flags: ${bits(v.irqFlags, ['raster', 'sprite-bg', 'sprite-sprite', 'lightpen'])}`,
    `IRQEN   D01A = ${hx(v.irqMask)}  enabled: ${bits(v.irqMask, ['raster', 'sprite-bg', 'sprite-sprite', 'lightpen'])}   ${v.irq ? 'IRQ asserted' : ''}`.trimEnd(),
    `Colours border ${r[0x20] & 15}  background ${r[0x21] & 15},${r[0x22] & 15},${r[0x23] & 15},${r[0x24] & 15}`,
    '',
    'Sprites (n  on  x    y    colour  flags):',
  ];
  for (let s = 0; s < 8; s++) {
    const x = r[s * 2] | (((r[0x10] >> s) & 1) << 8);
    const flags = [
      (r[0x17] >> s) & 1 ? 'tall' : '', (r[0x1D] >> s) & 1 ? 'wide' : '',
      (r[0x1C] >> s) & 1 ? 'multicolour' : '', (r[0x1B] >> s) & 1 ? 'behind' : '',
    ].filter(Boolean).join(' ');
    lines.push(`  ${s}   ${(r[0x15] >> s) & 1 ? 'on ' : 'off'} ${String(x).padStart(3)}  ${String(r[s * 2 + 1]).padStart(3)}  ${String(r[0x27 + s] & 15).padStart(2)}      ${flags}`);
  }
  lines.push(`Collisions  sprite-sprite ${hx(v.collisionSS)}  sprite-background ${hx(v.collisionSB)}`);
  lines.push('', 'Registers:');
  for (let i = 0; i < VIC_NAMES.length; i += 8) {
    lines.push('  ' + VIC_NAMES.slice(i, i + 8).map((n, k) => `${n}=${hx(r[i + k])}`).join(' '));
  }
  return lines.join('\n');
}

// ── SID ───────────────────────────────────────────────────────────────────

const ENVELOPE = ['attack', 'decay/sustain', 'release'];

function dumpSid(m: C64Machine): string {
  const s = m.sid;
  const lines: string[] = [];
  s.voices.forEach((v, i) => {
    const hz = (v.freq * C64_CPU_CLOCK) / 0x1000000;
    const wave = bits(v.control >> 4, ['triangle', 'saw', 'pulse', 'noise']);
    const flags = bits(v.control & 0x0F, ['GATE', 'sync', 'ring', 'TEST']);
    lines.push(
      `Voice ${i + 1}  D4${hx(i * 7)}  freq ${hx(v.freq, 4)} (${hz.toFixed(1)} Hz)  pulse width ${hx(v.pw, 4)}`,
      `         control ${hx(v.control)}  ${wave}  ${flags}`,
      `         AD ${hx(v.attackDecay)}  SR ${hx(v.sustainRelease)}  envelope ${v.envLevel} (${ENVELOPE[v.envState] ?? v.envState})`,
    );
  });
  const filt = s.resFilt & 0x0F;
  lines.push(
    `Filter   cutoff ${s.cutoff} (${hx(s.cutoff, 4)})  resonance ${s.resFilt >> 4}  routed: ${bits(filt, ['voice 1', 'voice 2', 'voice 3', 'external'])}`,
    `Mode/vol ${hx(s.modeVol)}  volume ${s.modeVol & 15}  ${bits((s.modeVol >> 4) & 15, ['low-pass', 'band-pass', 'high-pass', 'voice 3 OFF'])}`,
  );
  return lines.join('\n');
}

// ── CIAs ──────────────────────────────────────────────────────────────────

function dumpCia(c: Mos6526, base: number, portNotes: (c: Mos6526) => string[]): string {
  const timer = (n: string, t: Mos6526['ta']): string =>
    `Timer ${n}  counter ${hx(t.counter, 4)}  latch ${hx(t.latch, 4)}  control ${hx(t.control)}  ` +
    `${t.running ? 'running' : 'stopped'}, ${t.control & 8 ? 'one-shot' : 'continuous'}` +
    `${t.control & 2 ? `, output PB${n === 'A' ? 6 : 7}` : ''}`;
  const tod = (a: number, b: number, c2: number, d: number): string =>
    `${hx(a)}:${hx(b)}:${hx(c2)}.${(d & 15).toString(16)}${a & 0x80 ? ' PM' : ''}`;
  return [
    `PRA     ${hx(base, 4)} = ${hx(c.pra)}  DDRA ${hx(c.ddra)}  pins ${bin8(c.drivenA)}`,
    `PRB     ${hx(base + 1, 4)} = ${hx(c.prb)}  DDRB ${hx(c.ddrb)}  pins ${bin8(c.drivenB)}`,
    ...portNotes(c),
    timer('A', c.ta),
    timer('B', c.tb),
    `ICR     flags ${hx(c.icrFlags)} (${bits(c.icrFlags, ['TA', 'TB', 'alarm', 'serial', 'FLAG'])})  mask ${hx(c.icrMask)}  ${c.irq ? 'interrupt asserted' : ''}`.trimEnd(),
    `TOD     ${tod(c.todHr, c.todMin, c.todSec, c.todTenths)}  alarm ${tod(c.alarmHr, c.alarmMin, c.alarmSec, c.alarmTenths)}`,
    `SDR     ${hx(c.sdr)}`,
  ].join('\n');
}

function dumpCia1(m: C64Machine): string {
  return dumpCia(m.cia1, 0xDC00, (c) => [
    `        port A: keyboard columns / joystick 2   port B: keyboard rows / joystick 1`,
    `        joystick 2 ${bits(~c.drivenA & 0x1F, ['up', 'down', 'left', 'right', 'fire'])} (as driven)`,
  ]);
}

function dumpCia2(m: C64Machine): string {
  const drive = m.drive;
  return dumpCia(m.cia2, 0xDD00, (c) => {
    const a = c.drivenA;
    return [
      `        VIC bank ${(~a) & 3}   serial bus out: ATN ${a & 8 ? 'low' : 'high'}  CLK ${a & 0x10 ? 'low' : 'high'}  DATA ${a & 0x20 ? 'low' : 'high'}` +
        `${drive ? `   drive pulls: CLK ${drive.clkAsserted ? 'low' : 'high'}  DATA ${drive.dataAsserted ? 'low' : 'high'}` : ''}`,
      `        NMI source (with RESTORE): ${c.irq ? 'CIA 2' : 'none'}`,
    ];
  });
}

// ── PLA ───────────────────────────────────────────────────────────────────

function dumpPla(m: C64Machine): string {
  const mem = m.memory;
  return [
    `6510 port  $00 DDR = ${hx(mem.portDdr)}   $01 data = ${hx(mem.portData)}  (bits 0-2: LORAM, HIRAM, CHAREN)`,
    `Cassette   motor ${mem.motorOn ? 'on' : 'off'}`,
    '',
    `A000-BFFF  ${mem.basicIn ? 'BASIC ROM' : 'RAM'}`,
    `D000-DFFF  ${mem.ioIn ? 'I/O' : mem.charIn ? 'character ROM' : 'RAM'}`,
    `E000-FFFF  ${mem.kernalIn ? 'KERNAL ROM' : 'RAM'}`,
    `VIC bank   ${mem.vicBase >> 14} ($${hx(mem.vicBase, 4)}-$${hx(mem.vicBase + 0x3FFF, 4)})`,
  ].join('\n');
}

// ── 1541 ──────────────────────────────────────────────────────────────────

const VIA1_NAMES = ['serial bus', 'ATN/clock/data'];

function dumpVia(v: M6522): string[] {
  return [
    `  ORA ${hx(v.ora)} DDRA ${hx(v.ddra)}   ORB ${hx(v.orb)} DDRB ${hx(v.ddrb)}   ACR ${hx(v.acr)}  PCR ${hx(v.pcr)}`,
    `  T1 ${hx(v.t1Counter, 4)} (latch ${hx(v.t1Latch, 4)}${v.t1Running ? ', running' : ''})   T2 ${hx(v.t2Counter, 4)}${v.t2Running ? ' (running)' : ''}   SR ${hx(v.sr)}`,
    `  IFR ${hx(v.ifr)}  IER ${hx(v.ier)}  ${v.irq ? 'IRQ asserted' : ''}`.trimEnd(),
  ];
}

function dumpDrive(m: C64Machine): string {
  const d = m.drive;
  if (!d) return 'No disk drive fitted (tick the 1541 in the Hardware pane).';
  const c = d.cpu;
  const p = c.p;
  const flags = `${p & 0x80 ? 'N' : '-'}${p & 0x40 ? 'V' : '-'}-${p & 0x10 ? 'B' : '-'}${p & 8 ? 'D' : '-'}${p & 4 ? 'I' : '-'}${p & 2 ? 'Z' : '-'}${p & 1 ? 'C' : '-'}`;
  return [
    `CPU     PC ${hx(c.pc, 4)}  A ${hx(c.a)}  X ${hx(c.x)}  Y ${hx(c.y)}  SP ${hx(c.sp)}  P ${hx(p)} ${flags}`,
    `ROM     ${d.hasRom ? 'DOS ROM loaded' : 'NO DOS ROM'}`,
    `Disk    ${d.disk ? `${d.mediaName || 'disk'}${d.writeProtected ? ' (write protected)' : ''}${d.dirty ? ' (modified)' : ''}` : 'none'}`,
    `Head    track ${d.currentTrack}  half-track ${d.currentHalfTrack}  motor ${d.motorOn ? 'on' : 'off'}  LED ${d.ledOn ? 'on' : 'off'}${d.isWriting ? '  WRITING' : ''}`,
    `Bus     drive pulls CLK ${d.clkAsserted ? 'low' : 'high'}, DATA ${d.dataAsserted ? 'low' : 'high'}`,
    `VIA 1 ${VIA1_NAMES.join(' / ')} ($1800)`,
    ...dumpVia(d.via1),
    'VIA 2 disk controller ($1C00)',
    ...dumpVia(d.via2),
  ].join('\n');
}

export function c64Chips(m: C64Machine): readonly ChipSection[] {
  const chips: ChipSection[] = [
    { name: 'vic', description: 'VIC-II 6569: mode, memory pointers, raster, IRQ, colours, sprites', dump: () => dumpVic(m) },
    { name: 'sid', description: 'SID 6581: three voices (frequency, waveform, envelope), filter, volume', dump: () => dumpSid(m) },
    { name: 'cia1', description: 'CIA 1 ($DC00): keyboard, joysticks, timers, IRQ, cassette FLAG', dump: () => dumpCia1(m) },
    { name: 'cia2', description: 'CIA 2 ($DD00): VIC bank, serial bus, user port, timers, NMI', dump: () => dumpCia2(m) },
    { name: 'pla', description: '6510 I/O port and the PLA: which of BASIC, KERNAL, I/O and character ROM are banked in', dump: () => dumpPla(m) },
  ];
  if (m.drive) chips.push({ name: 'drive', description: '1541: its 6502, head, motor and LED, and the two 6522 VIAs (serial bus, disk controller)', dump: () => dumpDrive(m) });
  return chips;
}
