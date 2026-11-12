/**
 * Dumps of the chips the 64 and the 128 share, as the debugger's `chip_state`
 * shows them: the VIC-II (or the 128's VIC-IIe, the same registers), the SID
 * and the 6526 CIAs.
 *
 * Every dump reads the chips' own state, never the bus, so taking one clears
 * no interrupt flag and trips no watchpoint (a CIA ICR read would).
 */

import type { Mos6526 } from '@/cores/mos6526.ts';
import type { Mos6581 } from '@/cores/mos6581.ts';
import type { VicII } from '@/cores/vic-ii.ts';
import { hex8, hex16 } from '@/utils/hex.ts';

export const bits = (v: number, names: readonly string[]): string => {
  const on = names.filter((_, i) => names[i] && (v & (1 << i)) !== 0);
  return on.length ? on.join(' ') : '-';
};

export const hx = (v: number, w = 2): string => (w === 2 ? hex8(v) : hex16(v));
export const bin8 = (v: number): string => (v & 0xFF).toString(2).padStart(8, '0');

// ── VIC-II ────────────────────────────────────────────────────────────────

const VIC_NAMES = [
  'M0X', 'M0Y', 'M1X', 'M1Y', 'M2X', 'M2Y', 'M3X', 'M3Y', 'M4X', 'M4Y', 'M5X', 'M5Y', 'M6X', 'M6Y', 'M7X', 'M7Y',
  'MSBX', 'CR1', 'RASTER', 'LPX', 'LPY', 'ME', 'CR2', 'MYE', 'MEMPTR', 'IRQ', 'IRQEN', 'MDP', 'MMC', 'MXE', 'MM', 'MD',
  'EC', 'B0C', 'B1C', 'B2C', 'B3C', 'MM0', 'MM1', 'M0C', 'M1C', 'M2C', 'M3C', 'M4C', 'M5C', 'M6C', 'M7C',
];

/** The VIC-II's state; `bank` is the 16K bank CIA 2 has chosen for it. */
export function dumpVic(v: VicII, bank: number): string {
  const r = v.regs;
  const cr1 = r[0x11];
  const cr2 = r[0x16];
  const ecm = (cr1 & 0x40) !== 0;
  const bmm = (cr1 & 0x20) !== 0;
  const mcm = (cr2 & 0x10) !== 0;
  const mode = `${ecm ? 'ECM ' : ''}${bmm ? 'bitmap' : 'text'}${mcm ? ' multicolour' : ''}`;
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

export function dumpSid(s: Mos6581, clockHz: number): string {
  const lines: string[] = [`Chip      MOS ${s.model}${s.model === '8580' ? ' (centred, linear filter, no DC level)' : ' (S-curve filter, DC level, saturating)'}`];
  s.voices.forEach((v, i) => {
    const hz = (v.freq * clockHz) / 0x1000000;
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

export function dumpCia(c: Mos6526, base: number, portNotes: (c: Mos6526) => string[]): string {
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
