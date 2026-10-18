/**
 * EnterpriseMemory — Dave's segment paging.
 *
 * Dave maps any four of 256 16K segments into the Z80's four pages through
 * ports 0xB0-0xB3. ROMs live at the bottom of the segment space, RAM at the
 * top: the 128 fills segments 0xF8-0xFF, the 64 only 0xFC-0xFF. Those top four
 * are Nick's video RAM, the one 64K it can address — `videoRam` is that view.
 * Segments with nothing fitted read 0xFF and ignore writes.
 */

import type { IMachineMemory } from '@/machines/machine.ts';
import {
  EP_SEGMENT_SIZE, EP_SEGMENTS, EP_VIDEO_FIRST_SEGMENT,
} from './constants.ts';
import { enterpriseRamSegments, type EnterpriseModel } from './models.ts';

/** What an unpopulated segment reads as. */
const OPEN_BUS = new Uint8Array(EP_SEGMENT_SIZE).fill(0xFF);
/** Where writes to ROM and empty segments go. */
const DISCARD = new Uint8Array(EP_SEGMENT_SIZE);

export class EnterpriseMemory implements IMachineMemory {
  /** All of the fitted RAM, segment `firstRamSegment` first. */
  readonly ram: Uint8Array;
  /** Nick's 64K: segments 0xFC-0xFF, the top of `ram`. */
  readonly videoRam: Uint8Array;
  readonly firstRamSegment: number;

  /** Each segment's contents, or null when nothing is fitted there. */
  private readonly segments: (Uint8Array | null)[] = new Array(EP_SEGMENTS).fill(null);
  /** Segments that hold ROM (read-only). */
  private readonly romSegments = new Uint8Array(EP_SEGMENTS);

  /** The segment each Z80 page shows (ports 0xB0-0xB3 as last written). */
  readonly pages = new Uint8Array(4);
  /** The page views the CPU reads and writes through. */
  private readonly readPage: Uint8Array[] = [OPEN_BUS, OPEN_BUS, OPEN_BUS, OPEN_BUS];
  private readonly writePage: Uint8Array[] = [DISCARD, DISCARD, DISCARD, DISCARD];
  /** Bit n set: page n shows video RAM, so the CPU waits for Nick. */
  videoPageMask = 0;

  constructor(model: EnterpriseModel) {
    const count = enterpriseRamSegments(model);
    this.firstRamSegment = EP_SEGMENTS - count;
    this.ram = new Uint8Array(count * EP_SEGMENT_SIZE);
    this.videoRam = this.ram.subarray(this.ram.length - 4 * EP_SEGMENT_SIZE);
    for (let i = 0; i < count; i++) {
      this.segments[this.firstRamSegment + i] =
        this.ram.subarray(i * EP_SEGMENT_SIZE, (i + 1) * EP_SEGMENT_SIZE);
    }
    this.reset();
  }

  /**
   * Fit a ROM at `firstSegment`, one segment per 16K of image (a partial last
   * segment is padded with 0xFF), or clear `maxSegments` segments when `data`
   * is null. Re-pages anything currently showing those segments.
   */
  loadRom(firstSegment: number, data: Uint8Array | null, maxSegments: number): void {
    for (let i = 0; i < maxSegments; i++) {
      const seg = firstSegment + i;
      const at = i * EP_SEGMENT_SIZE;
      if (data && at < data.length) {
        const image = new Uint8Array(EP_SEGMENT_SIZE).fill(0xFF);
        image.set(data.subarray(at, Math.min(data.length, at + EP_SEGMENT_SIZE)));
        this.segments[seg] = image;
        this.romSegments[seg] = 1;
      } else {
        this.segments[seg] = null;
        this.romSegments[seg] = 0;
      }
    }
    for (let p = 0; p < 4; p++) this.setPage(p, this.pages[p]);
  }

  /** The contents of a segment, or null when nothing is fitted there. */
  segment(seg: number): Uint8Array | null { return this.segments[seg & 0xFF]; }

  isRomSegment(seg: number): boolean { return this.romSegments[seg & 0xFF] !== 0; }

  /** Port 0xB0 + page: show segment `seg` in Z80 page `page`. */
  setPage(page: number, seg: number): void {
    page &= 3;
    seg &= 0xFF;
    this.pages[page] = seg;
    const contents = this.segments[seg];
    this.readPage[page] = contents ?? OPEN_BUS;
    this.writePage[page] = contents && !this.romSegments[seg] ? contents : DISCARD;
    if (contents && seg >= EP_VIDEO_FIRST_SEGMENT) this.videoPageMask |= 1 << page;
    else this.videoPageMask &= ~(1 << page);
  }

  readByte(addr: number): number {
    return this.readPage[(addr >> 14) & 3][addr & 0x3FFF];
  }

  writeByte(addr: number, val: number): void {
    this.writePage[(addr >> 14) & 3][addr & 0x3FFF] = val;
  }

  readBlock(addr: number, len: number): Uint8Array {
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = this.readByte((addr + i) & 0xFFFF);
    return out;
  }

  snapshot(): Uint8Array { return this.readBlock(0, 0x10000); }

  /** RAM by segment, counting from the first fitted one. */
  getRamBank(n: number): Uint8Array {
    const count = this.ramBankCount;
    const i = ((n % count) + count) % count;
    return this.ram.subarray(i * EP_SEGMENT_SIZE, (i + 1) * EP_SEGMENT_SIZE);
  }

  get ramBankCount(): number { return this.ram.length / EP_SEGMENT_SIZE; }

  /** Power-on: every page shows segment 0, the start of EXOS. RAM is left as
   *  it is — EXOS tests and clears it itself. */
  reset(): void {
    for (let p = 0; p < 4; p++) this.setPage(p, 0);
  }
}
