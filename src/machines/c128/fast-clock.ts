/**
 * The 8502's 2 MHz clock against the 1 MHz one the rest of the machine keeps.
 *
 * The VIC-IIe makes the CPU's clock, and in 2 MHz mode ($D030 bit 0) the CPU
 * gets two cycles to the master cycle, with these exceptions (the C128 test
 * programs of the VICE project run on real machines and fix them):
 *
 *  - the five cycles of DRAM refresh every line run at 1 MHz, whatever the CPU
 *    is doing, so a fast PAL line is 2 x 58 + 5 = 121 CPU cycles (NTSC 125);
 *  - an access to the I/O page ($D000-$DFFF) ends on a 1 MHz edge: one that
 *    starts on the second half of a master cycle costs nothing extra, one that
 *    starts on the first costs a half. A read-modify-write makes three accesses
 *    (read, the old value written back, the new one), so `inc $d020` takes 8
 *    cycles against 6 for `inc $c000`.
 *
 * Time here is in half master cycles ("halves"): the CPU's cycle is one half
 * unless one of those stretches it.
 */

/** The five refresh cycles of a line, from this 0-based cycle of it. The test
 *  programs fix how many; where they sit comes from running them (the 2mhzVIC and
 *  timing-change pictures draw correctly from 9 on, not before or after), and is
 *  tied to how this machine times its interrupt entry. */
export const REFRESH_FIRST = 9;
export const REFRESH_CYCLES = 5;

/** The data bus of one CPU cycle `i` (1-based) of an instruction: the opcode
 *  and its operand bytes on cycles 1 to `length`, the byte after them on the
 *  second cycle of a one-byte instruction (the dummy read), and otherwise the
 *  data the instruction moved (`data`, the last byte it read or wrote). */
export function busByte(i: number, length: number, fetched: ArrayLike<number>, data: number): number {
  return i <= length || (length === 1 && i === 2) ? fetched[i - 1] : data;
}

/**
 * Lay out the cycles of one instruction on the half-cycle clock from half
 * `h0`. `cycles` is the core's count, `io` the 1-based cycles that are accesses
 * to the I/O page, `lineStart` the master cycle the current line began on and
 * `lineLength` its length. For each half the instruction covers `put` is given
 * the half and the byte on the bus (`bus(i)` for the 1-based cycle). Returns
 * the half the instruction ends on.
 */
export function layOut(
  h0: number, cycles: number, io: readonly number[],
  lineStart: number, lineLength: number,
  bus: (i: number) => number, put: (half: number, byte: number) => void,
): number {
  let h = h0;
  for (let i = 1; i <= cycles; i++) {
    const inLine = (((h >> 1) - lineStart) % lineLength + lineLength) % lineLength;
    let d = 1;
    if (inLine >= REFRESH_FIRST && inLine < REFRESH_FIRST + REFRESH_CYCLES) d = 2;
    else if (io.includes(i)) d = (h & 1) !== 0 ? 1 : 2;
    const byte = bus(i);
    for (let k = 0; k < d; k++) put(h + k, byte);
    h += d;
  }
  return h;
}
