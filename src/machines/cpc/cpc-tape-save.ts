/**
 * Amstrad CPC tape saving — turning what the cassette write line did into a
 * .cdt.
 *
 * Nothing traps CAS WRITE: the firmware shapes the waveform itself by
 * flipping PPI Port C bit 5, and the machine's PulseRecorder times the
 * flips. The firmware's encoding (the cassette manager chapter of the CPC
 * firmware guide) is:
 *
 *   leader   2048 one bits (4096 equal half-cycles)
 *   sync     one zero bit
 *   record   the sync character (&2C header, &16 data), then the data in
 *            256-byte segments each followed by its CRC, then a trailer of
 *            32 one bits
 *
 * where a bit is one cycle of two equal halves and a 1 is twice as long as a
 * 0. The speed is not fixed — SPEED WRITE / CAS SET SPEED choose the half
 * period, and write precompensation stretches halves next to a change of
 * bit — so the bit widths are taken from each leader rather than assumed.
 *
 * Each record becomes a TZX turbo block (0x11) — the form .cdt files use for
 * firmware blocks — carrying the bytes verbatim (sync character, CRCs and
 * trailer included) with the measured timings, which zx84's firmware read
 * trap and its pulse-level playback both accept. Anything else with a pilot
 * tone (a custom saver) is kept as its exact pulse widths (CSW block 0x18).
 * Widths are converted from the CPC's 4 MHz T-states to the 3.5 MHz unit
 * TZX/CDT timings are written in.
 */

import type { BitGeometry, PulseBlock } from '@/media/tape/pulse-decode.ts';
import { pulsesToTzxBlocks } from '@/media/tape/pulse-decode.ts';
import { encodeTzx, type TzxOutBlock } from '@/media/tape/tzx-writer.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';
import { CPC_CPU_CLOCK } from './constants.ts';

const HEADER_SYNC = 0x2C;

/** Widest and narrowest one-bit half period the firmware can be asked for,
 *  with margin, in 3.5 MHz T-states: CAS SET SPEED takes a zero-bit half
 *  period of 130–480 µs (one-bit halves twice that). */
const MIN_PILOT = 0.2e-3 * TAPE_REF_HZ;
const MAX_PILOT = 1.2e-3 * TAPE_REF_HZ;

/** A leader of one bits fixes the speed: zeros (and the sync bit) are half
 *  its width. */
function firmwareGeometry(pilot: number): BitGeometry | null {
  if (pilot < MIN_PILOT || pilot > MAX_PILOT) return null;
  const zero = pilot / 2;
  return { sync1: zero, sync2: zero, bit0: zero, bit1: pilot };
}

function firmwareBlock(b: PulseBlock): TzxOutBlock {
  return {
    kind: 'turbo', data: b.data, pause: 0,
    pilot: b.pilot, sync1: b.sync1, sync2: b.sync2, bit0: b.bit0, bit1: b.bit1,
    pilotCount: b.pilotCount, usedBits: b.usedBits,
  };
}

/** Decode a cassette-write capture (CPC T-states between edges) into
 *  TZX/CDT blocks. */
export function cpcSaveBlocks(pulses: ArrayLike<number>): TzxOutBlock[] {
  const scale = TAPE_REF_HZ / CPC_CPU_CLOCK;
  const ref = new Float64Array(pulses.length);
  for (let i = 0; i < pulses.length; i++) ref[i] = pulses[i] * scale;
  return pulsesToTzxBlocks(ref, firmwareGeometry, firmwareBlock);
}

/** The filename from the first header record (bytes 0–15 of the header,
 *  after the sync character), if any. */
function headerName(blocks: readonly TzxOutBlock[]): string {
  for (const b of blocks) {
    if (b.kind === 'turbo' && b.data.length > 17 && b.data[0] === HEADER_SYNC) {
      let name = '';
      for (let i = 1; i <= 16; i++) {
        const c = b.data[i] & 0x7F;
        if (c === 0) break;
        name += c >= 0x20 && c < 0x7F ? String.fromCharCode(c) : ' ';
      }
      return name.trim();
    }
  }
  return '';
}

/** Characters a download name cannot hold become '_'. */
function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9 ._()-]/g, '_').trim();
}

/** The recording as .cdt bytes plus a name, or null when it holds no block. */
export function cpcSaveToCdt(pulses: ArrayLike<number>): { data: Uint8Array; filename: string } | null {
  const blocks = cpcSaveBlocks(pulses);
  if (blocks.length === 0) return null;
  const name = fileSafe(headerName(blocks)).replace(/\.$/, '');
  return { data: encodeTzx(blocks), filename: `${name || 'cpc-tape'}.cdt` };
}
