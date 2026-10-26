/**
 * Atari DOS executables (`.xex`, also `.com`): parser and native loader.
 *
 * Format (DOS 2 binary load): $FF $FF, then segments of start address, end
 * address (inclusive, both little-endian) and the bytes between. Later
 * segments may repeat the $FF $FF marker. Two OS locations give a file
 * behaviour beyond "copy these bytes":
 *
 *   INITAD $02E2  set by a segment that wants a routine called as soon as it
 *                 has loaded (title screens, decrunchers, loader stages);
 *                 DOS clears it before each segment and JSRs it after
 *   RUNAD  $02E0  where to start once the whole file is in
 *
 * Loading without DOS: mounting a file arms a boot. During the OS's own disk
 * boot the SIO fast path answers D1: with a one-sector boot record whose code
 * jumps to XEX_TRAP, an address in the unmapped part of the I/O window where
 * no program runs. The machine catches the CPU arriving there and does what
 * DOS would: write each segment, call INITAD (with the trap as its return
 * address, so control comes back here), then jump to RUNAD. Nothing of the
 * loader lives in RAM, so files that load anywhere, page 6 or the boot area
 * included, load intact.
 */

export interface XexSegment {
  readonly start: number;
  readonly end: number;
  readonly data: Uint8Array;
}

/** Where the loader's trap sits: unmapped I/O, never real code. */
export const XEX_TRAP = 0xd5fe;

const INITAD = 0x02e2;
const RUNAD = 0x02e0;
const DOSVEC = 0x000a;
/** Where the OS loads boot sectors. */
const BOOT_ADDR = 0x0700;

/** Parse a binary-load file, or null if it is not one. Trailing bytes too
 *  short to be a segment (padding some files carry) are ignored. */
export function parseXex(data: Uint8Array): XexSegment[] | null {
  if (data.length < 7 || data[0] !== 0xff || data[1] !== 0xff) return null;
  const segments: XexSegment[] = [];
  let at = 2;
  while (at + 4 <= data.length) {
    let start = data[at] | (data[at + 1] << 8);
    if (start === 0xffff) {
      at += 2;
      if (at + 4 > data.length) break;
      start = data[at] | (data[at + 1] << 8);
    }
    const end = data[at + 2] | (data[at + 3] << 8);
    at += 4;
    if (end < start) break;
    const length = end - start + 1;
    if (at + length > data.length) {
      // A truncated last segment: load what is there, as DOS would.
      if (at < data.length) segments.push({ start, end: start + (data.length - at) - 1, data: data.slice(at) });
      break;
    }
    segments.push({ start, end, data: data.slice(at, at + length) });
    at += length;
  }
  return segments.length > 0 ? segments : null;
}

/**
 * The boot record served as D1: sector 1 while a file is waiting to load:
 * flags 0, one sector, load at $0700, DOSINI = $0709 (an RTS), and at $0706
 * `JMP XEX_TRAP`, which the OS reaches when it calls the boot code.
 */
export function xexBootSector(): Uint8Array {
  const s = new Uint8Array(128);
  s.set([0x00, 0x01, BOOT_ADDR & 0xff, BOOT_ADDR >> 8, 0x09, 0x07]);
  s.set([0x4c, XEX_TRAP & 0xff, XEX_TRAP >> 8, 0x60], 6);
  return s;
}

/** What the loader needs from the machine. */
export interface XexHost {
  read(addr: number): number;
  write(addr: number, value: number): void;
  /** Push a return address so an RTS lands on `addr`. */
  pushReturn(addr: number): void;
  jump(addr: number): void;
}

export type XexPhase = 'boot' | 'loading' | 'running';

export class XexLoader {
  phase: XexPhase = 'boot';
  private next = 0;

  constructor(readonly name: string, readonly segments: readonly XexSegment[]) {}

  /** How far through the segments the loader has got, for snapshots. */
  get progress(): number { return this.next; }

  /** Put the loader back where a snapshot found it. */
  restore(phase: XexPhase, next: number): void {
    this.phase = phase;
    this.next = next;
  }

  /** Arm the boot again (a reset reloads the file, as it would reboot DOS). */
  rearm(): void {
    this.phase = 'boot';
    this.next = 0;
  }

  /** The CPU reached XEX_TRAP: load on, call an init routine, or run. */
  trap(host: XexHost): void {
    const read16 = (a: number) => host.read(a) | (host.read(a + 1) << 8);
    if (this.phase === 'running') {
      // The program returned to "DOS": go where DOSVEC points.
      host.jump(read16(DOSVEC));
      return;
    }
    if (this.phase === 'boot') {
      this.phase = 'loading';
      host.write(RUNAD, 0);
      host.write(RUNAD + 1, 0);
    }
    while (this.next < this.segments.length) {
      const seg = this.segments[this.next++];
      host.write(INITAD, 0);
      host.write(INITAD + 1, 0);
      for (let i = 0; i < seg.data.length; i++) host.write((seg.start + i) & 0xffff, seg.data[i]);
      const init = read16(INITAD);
      if (init !== 0) {
        host.pushReturn(XEX_TRAP);
        host.jump(init);
        return;
      }
    }
    this.phase = 'running';
    const run = read16(RUNAD) || this.segments[0].start;
    host.pushReturn(XEX_TRAP);
    host.jump(run);
  }
}
