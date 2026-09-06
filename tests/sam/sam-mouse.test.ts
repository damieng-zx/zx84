/**
 * MGT SAM Mouse Interface.
 *
 * The protocol is a nine-byte nibble stream restarted by a gap in the reads,
 * so the tests are about ORDER and TIMING as much as values: which byte comes
 * out when, what a pause does, and what happens to movement that arrives while
 * a report is being read.
 */

import { describe, expect, it } from 'vitest';
import { SamMouse, SAM_MOUSE_RESET_T } from '@/machines/sam/sam-mouse.ts';

/** Read `n` bytes back to back — inside the restart window. */
function burst(m: SamMouse, n: number, startT = 1_000_000): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(m.read(startT + i * 10));
  return out;
}

/** Low nibble of a port value — the only part the interface actually drives. */
const nib = (v: number) => v & 0x0F;

describe('SamMouse', () => {
  it('opens every report with the two strobe bytes', () => {
    const m = new SamMouse();
    const r = burst(m, 3);
    expect(r[0]).toBe(0xFF);
    expect(r[1]).toBe(0xFF);
    // Third byte is the buttons, inverted: nothing pressed reads all ones.
    expect(r[2]).toBe(0xFF);
  });

  it('forces the high nibble, so only four bits carry data', () => {
    const m = new SamMouse();
    m.motion(1, 0);
    for (const v of burst(m, 9)) expect(v & 0xF0).toBe(0xF0);
  });

  it('reports buttons inverted, one bit each', () => {
    const m = new SamMouse();
    m.button(0, true);         // left  -> bit 0
    m.button(2, true);         // right -> bit 2
    expect(nib(burst(m, 3)[2])).toBe(~0b101 & 0x0F);
  });

  it('splits movement into three nibbles, most significant first', () => {
    const m = new SamMouse();
    // Host Y is inverted by the interface, so -3 upward becomes +3.
    m.motion(0x25, -3);
    const r = burst(m, 9).map(nib);
    // buffer: strobe, strobe, buttons, Y2 Y1 Y0, X2 X1 X0
    expect([r[3], r[4], r[5]]).toEqual([0x0, 0x0, 0x3]);
    expect([r[6], r[7], r[8]]).toEqual([0x0, 0x2, 0x5]);
  });

  it('reports negative movement in 12-bit twos complement', () => {
    const m = new SamMouse();
    m.motion(-1, 0);
    const r = burst(m, 9).map(nib);
    expect([r[6], r[7], r[8]]).toEqual([0xF, 0xF, 0xF]);
  });

  it('clamps a large movement to the driver limit', () => {
    const m = new SamMouse();
    m.motion(5000, 0);
    const r = burst(m, 9).map(nib);
    // 127 = 0x07F
    expect([r[6], r[7], r[8]]).toEqual([0x0, 0x7, 0xF]);
  });

  it('subtracts only what it reported, so movement is never lost', () => {
    const m = new SamMouse();
    m.motion(200, 0);                       // more than one report can carry
    const first = burst(m, 9).map(nib);
    expect([first[6], first[7], first[8]]).toEqual([0x0, 0x7, 0xF]); // 127

    const second = burst(m, 9, 2_000_000).map(nib);
    expect([second[6], second[7], second[8]]).toEqual([0x0, 0x4, 0x9]); // 200-127
  });

  it('latches movement once per report, not once per read', () => {
    const m = new SamMouse();
    m.motion(1, 0);
    const t = 1_000_000;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) seen.push(m.read(t + i * 10));
    // Movement arriving mid-report must not change the X bytes still to come.
    m.motion(0x40, 0);
    seen.push(m.read(t + 60), m.read(t + 70), m.read(t + 80));
    expect(seen.slice(6).map(nib)).toEqual([0x0, 0x0, 0x1]);
  });

  it('restarts the report after a gap longer than the reset window', () => {
    const m = new SamMouse();
    m.read(1_000_000);
    m.read(1_000_010);                       // mid-report
    expect(m.sequential).toBe(true);
    const after = m.read(1_000_010 + SAM_MOUSE_RESET_T + 1);
    expect(m.sequential).toBe(false);
    expect(after).toBe(0xFF);                // back at the strobe
  });

  it('wraps straight back to the strobe after the last byte', () => {
    const m = new SamMouse();
    const r = burst(m, 11);
    expect(r[9]).toBe(0xFF);
    expect(r[10]).toBe(0xFF);
  });

  it('reads as an empty socket when the interface is unplugged', () => {
    const m = new SamMouse();
    m.enabled = false;
    m.motion(10, 10);
    m.button(0, true);
    expect(burst(m, 4)).toEqual([0xFF, 0xFF, 0xFF, 0xFF]);
  });

  it('drops held buttons and pending movement on reset', () => {
    const m = new SamMouse();
    m.motion(30, 30);
    m.button(1, true);
    m.reset();
    const r = burst(m, 9).map(nib);
    expect(r[2]).toBe(0x0F);                                  // no buttons
    expect([r[3], r[4], r[5], r[6], r[7], r[8]]).toEqual([0, 0, 0, 0, 0, 0]);
  });
});
