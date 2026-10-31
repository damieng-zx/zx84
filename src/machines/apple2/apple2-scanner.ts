/**
 * The Apple II's video scanner: which RAM address it is reading on any CPU cycle.
 *
 * The video generator reads one byte of display memory on every cycle of the
 * 1 MHz clock, in the first half (the CPU uses the second), whether or not the
 * picture is being drawn. A CPU read of an address that nothing drives — a soft
 * switch that only has a side effect, an empty slot — sees the byte the scanner
 * just put on the bus, which is how programs find out where the beam is
 * (Sather, "Understanding the Apple II", ch. 5; "Understanding the Apple IIe",
 * ch. 5 and 8).
 *
 * The scanner's counters, and so this model:
 *
 *  - A line is 65 cycles: the horizontal counter runs $00, then $40-$7F. States
 *    $58-$7F are the 40 visible columns (cycles 25-64 of the line here), and
 *    the 25 before them, $00 and $40-$57, are horizontal blanking. $00 and $40
 *    differ only in a bit the address does not use, so the first two blanking
 *    cycles read the same byte.
 *  - The address within a 128-byte row segment is the counter plus 40 for every
 *    step of the vertical counter's V3-V4 (the three rows, 0/40/80 bytes in,
 *    that share a segment, and a fourth step of 120), modulo 128. So the 24 blanking
 *    bytes are the 24 just below the row's first byte (wrapping within the
 *    segment), not the ones after the last column.
 *  - The vertical counter runs 262 lines: 192 displayed, then 64 counting on
 *    from row 56 ($1C0-$1FF) and 6 more ($FA-$FF) which wrap round to
 *    the bottom segment row. All 70 blanking lines have V3-V4 both set, so they
 *    read from 8 bytes below a segment's start.
 *  - A text or lores line reads `$400`/`$800` plus its segment; a hires line
 *    adds its scan line (V0-V2 of the line, three more address bits) to
 *    `$2000`/`$4000`. Mixed mode switches to text for rows with V2 and V4 set.
 *  - On the ][ and ][+ the blanking bytes of a text or lores line come from
 *    $1000 higher; the //e has no such offset.
 */

/** Cycles in a line and a frame. */
const LINE = 65;
/** The first visible cycle of a line: the 25 before it are blanking. */
const FIRST_VISIBLE = 25;

/**
 * The address the scanner reads on `cycle` of the frame (0-17029; line 0
 * cycle 0 is the first blanking cycle of the first displayed line).
 * `text`/`mixed`/`hires` are the display switches, `page2` the page the
 * display shows (PAGE2 is ignored by the picture with 80STORE, so a //e passes it
 * as false then) and `iie` whether the machine is a //e. No allocation.
 */
export function scannerAddress(
  cycle: number, text: boolean, mixed: boolean, hires: boolean, page2: boolean, iie: boolean,
): number {
  const line = (cycle / LINE) | 0;
  const c = cycle - line * LINE;

  // The vertical counter: the character row (V0-V5) and the scan line in it.
  let row: number;
  let scan: number;
  if (line < 192) {
    row = line >> 3;
    scan = line & 7;
  } else if (line < 256) {
    row = 56 + ((line - 192) >> 3);   // V = $1C0 + (line - 192)
    scan = (line - 192) & 7;
  } else {
    const v = 250 + (line - 256);     // V = $FA...$FF
    row = v >> 3;
    scan = v & 7;
  }

  // 40 bytes per V3-V4 step: rows 0-7 start at 0, rows 8-15 at 40, 16-23 at 80
  // and (blanking only) the fourth step at 120.
  const start = 40 * ((row >> 3) & 3);
  const blank = c < FIRST_VISIBLE;
  // Visible column c-25; blanking cycles 1-24 are columns -24 to -1, and cycle
  // 0 repeats cycle 1.
  const col = blank ? (c === 0 ? -24 : c - 25) : c - FIRST_VISIBLE;
  const within = ((start + col) & 0x7F) | ((row & 7) << 7);

  const graphics = !text && !(mixed && (row & 20) === 20);
  if (graphics && hires) return (page2 ? 0x4000 : 0x2000) + (scan << 10) + within;
  return (page2 ? 0x800 : 0x400) + within + (blank && !iie ? 0x1000 : 0);
}
