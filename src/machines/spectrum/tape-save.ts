/**
 * ZX Spectrum tape saving — turning what the MIC line did into a .tzx.
 *
 * Nothing traps SAVE: the ROM's SA-BYTES routine (0x04C2) shapes the cassette
 * waveform by writing bit 3 of port 0xFE, exactly as it drives a real
 * recorder, and the machine's PulseRecorder times the transitions. This
 * module reads that pulse train back.
 *
 * The ROM's waveform, in T-states per half-cycle (the figures the TZX
 * specification gives for its standard-speed block, which are the
 * instruction timings of SA-BYTES):
 *
 *   pilot  2168    (8063 pulses before a header, 3223 before data —
 *                   chosen by bit 7 of the flag byte)
 *   sync   667, then 735
 *   bit 0  two 855 half-cycles    bit 1  two 1710 half-cycles, MSB first
 *
 * Blocks at that speed become TZX standard-speed blocks (0x10) — the same
 * bytes a .tap would hold — or turbo blocks (0x11) with the measured timings
 * when the leader length or a partial last byte rules a 0x10 out. Anything
 * else with a pilot tone (a turbo saver) is kept as its exact pulse widths in
 * a CSW recording block (0x18), so a custom loader sees what was written.
 */

import type { BitGeometry, PulseBlock } from '@/media/tape/pulse-decode.ts';
import { pulsesToTzxBlocks } from '@/media/tape/pulse-decode.ts';
import { encodeTzx, type TzxOutBlock } from '@/media/tape/tzx-writer.ts';

const PILOT = 2168;
const SYNC1 = 667;
const SYNC2 = 735;
const BIT0 = 855;
const BIT1 = 1710;
const PILOT_HEADER = 8063;
const PILOT_DATA = 3223;

/** The ROM's geometry, for a leader within 10% of its pilot. A data half is
 *  never wider than the midpoint between a 1 and the pilot. */
const ROM_GEOMETRY: BitGeometry = {
  sync1: SYNC1, sync2: SYNC2, bit0: BIT0, bit1: BIT1, maxBit: (BIT1 + PILOT) / 2,
};

function romGeometry(pilot: number): BitGeometry | null {
  return Math.abs(pilot - PILOT) <= PILOT * 0.1 ? ROM_GEOMETRY : null;
}

const within = (v: number, want: number, tol: number): boolean => Math.abs(v - want) <= want * tol;

/** A ROM-speed block as a TZX block: standard when a 0x10 replays it as
 *  recorded, else turbo with what was measured. */
function romBlock(b: PulseBlock): TzxOutBlock {
  const flag = b.data[0];
  const wantPilot = flag < 0x80 ? PILOT_HEADER : PILOT_DATA;
  if (b.usedBits === 8 && b.data.length <= 0xFFFF
    && within(b.pilotCount, wantPilot, 0.02)
    && within(b.bit0, BIT0, 0.1) && within(b.bit1, BIT1, 0.1)) {
    return { kind: 'standard', data: b.data, pause: 0 };
  }
  return {
    kind: 'turbo', data: b.data, pause: 0,
    pilot: b.pilot, sync1: b.sync1, sync2: b.sync2, bit0: b.bit0, bit1: b.bit1,
    pilotCount: b.pilotCount, usedBits: b.usedBits,
  };
}

/** Decode a MIC capture (T-states between edges; Spectrum T-states are the
 *  TZX unit) into TZX blocks. */
export function spectrumSaveBlocks(pulses: ArrayLike<number>): TzxOutBlock[] {
  return pulsesToTzxBlocks(pulses, romGeometry, romBlock);
}

/** The program name from the first ROM header on the recording, if any. */
function headerName(blocks: readonly TzxOutBlock[]): string {
  for (const b of blocks) {
    if ((b.kind === 'standard' || b.kind === 'turbo') && b.data.length >= 19 && b.data[0] === 0x00) {
      let name = '';
      for (let i = 2; i < 12; i++) {
        const c = b.data[i];
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

/** The recording as .tzx bytes plus a name, or null when it holds no block. */
export function spectrumSaveToTzx(pulses: ArrayLike<number>): { data: Uint8Array; filename: string } | null {
  const blocks = spectrumSaveBlocks(pulses);
  if (blocks.length === 0) return null;
  const name = fileSafe(headerName(blocks));
  return { data: encodeTzx(blocks), filename: `${name || 'spectrum-tape'}.tzx` };
}
