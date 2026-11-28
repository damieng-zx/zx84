/**
 * The on-screen keyboards' modifier latch, shared by every matrix machine.
 *
 * An on-screen cap is a pointer press, which has no "hold": to type a chord the
 * user clicks a modifier and then the key it modifies. So a modifier cap latches
 * — it asserts its matrix bit(s) and keeps them asserted while the pointer has
 * let go. This is that latch, and it is the one place it is implemented.
 *
 * Two latch behaviours, which is all any of these keyboards need:
 *
 *   • 'oneshot' — held until the next ordinary key is *released*, then let go
 *     (CAPS SHIFT, SYMBOL SHIFT). Click it again to unlatch. Two one-shots
 *     latched together make a momentary chord (Spectrum CAPS+SYMBOL → EXTEND
 *     MODE), which is pulsed rather than held: holding both makes the ROM
 *     auto-repeat the mode toggle so it flickers.
 *   • 'hold' — stays latched until clicked again; ordinary keys leave it alone
 *     (EXTEND MODE, GRAPH, CAPS LOCK, the Atom's CTRL/REPT).
 *
 * A machine supplies the three things that differ: how to reach the live matrix,
 * how to read its rows for highlighting, and how to press/release a cell. The
 * Matrix Key keyboards (Spectrum, Ace, ZX80/81) and the Atom (which has its own
 * latching cell model) both fit that shape.
 *
 * The latch outlives the pointer but not the pane, and the *machine* outlives
 * both: a pane closed with SHIFT latched used to leave that bit held, so the
 * machine read a permanently pressed SHIFT and every later key typed as its
 * shift level. `onCleanup` releases everything this controller asserted —
 * that is the A2 fix, and the reason there is one controller rather than three.
 */

import { createSignal, onCleanup } from 'solid-js';

/** How a sticky key latches — see the file header. */
export type LatchMode = 'oneshot' | 'hold';

/** One matrix cell. */
export type LatchCell = readonly [row: number, bit: number];

/** The live matrix behind an on-screen keyboard, or null while another machine
 *  is running. */
export interface LatchTarget {
  /** Press or release one cell (reference-counted by the machine's keyboard). */
  setKey(row: number, bit: number, down: boolean): void;
}

export interface LatchKeyboardOptions<K> {
  /** The live keyboard, or null while another machine is running. */
  keyboard: () => K | null;
  /** Live row bytes, and a pointer's press/release (usually the keyboard's own
   *  `rows` and `setKey`). */
  rows: (kb: K) => ArrayLike<number>;
  setKey: (kb: K, row: number, bit: number, down: boolean) => void;
  /** How many rows the matrix has. */
  rowCount?: number;
  /** What a row reads when nothing is pressed (active-low machines: 0xff). */
  released?: number;
  /** True (the default) when a pressed key reads as a clear bit. */
  activeLow?: boolean;
  /**
   * Hold time for a momentary chord, in ms. Long enough for the ROM's 50Hz
   * keyboard scan to register it several times, but well under the auto-repeat
   * delay (REPDEL ≈ 0.7 s) so a mode toggle fires exactly once instead of
   * flickering in and out.
   */
  chordPulseMs?: number;
}

export interface KeyboardController<T> {
  /** True when every cell of the key is currently held. */
  isDown(positions: readonly T[]): boolean;
  /** Press a key, or toggle a sticky latch. */
  onDown(positions: readonly T[], latch?: LatchMode): void;
  /** Release a momentary key and clear any one-shot latches. */
  onUp(positions: readonly T[], latch?: LatchMode): void;
}

const DEFAULT_CHORD_PULSE_MS = 120;

/** Cell-list helper: a key is a list of [row, bit] positions. */
export type CellKey = readonly LatchCell[];

export function useLatchKeyboard<K>(
  options: LatchKeyboardOptions<K>,
): KeyboardController<LatchCell> {
  const {
    keyboard, rows: readRows, setKey,
    rowCount = 8, released = 0xff,
    activeLow = true, chordPulseMs = DEFAULT_CHORD_PULSE_MS,
  } = options;

  const releasedRows = (): number[] => new Array<number>(rowCount).fill(released);
  const [matrix, setMatrix] = createSignal<number[]>(releasedRows());

  /** Every latched key, by a stable id of its positions. */
  const [latched, setLatched] = createSignal<ReadonlyMap<string, { positions: CellKey; hold: boolean }>>(new Map());

  /** Chord-pulse state: the cells currently pulsed down, awaiting release. */
  let chordTimer: ReturnType<typeof setTimeout> | undefined;
  let chordCells: LatchCell[] = [];

  const idOf = (positions: CellKey): string => positions.map(([r, b]) => `${r},${b}`).join('|');
  const press = (kb: K, positions: CellKey, down: boolean): void => {
    for (const [r, b] of positions) setKey(kb, r, b, down);
  };

  // Mirror the live matrix once per frame so physical keystrokes light the caps
  // too, not just pointer presses.
  const poll = (): void => {
    const kb = keyboard();
    if (kb) {
      const live = readRows(kb);
      const current = matrix();
      let changed = false;
      for (let index = 0; index < rowCount; index++) {
        if (live[index] !== current[index]) { changed = true; break; }
      }
      if (changed) setMatrix(Array.from({ length: rowCount }, (_, index) => live[index]));
    } else if (matrix().some((value) => value !== released)) {
      setMatrix(releasedRows());
    }
  };

  const isDown = (positions: CellKey): boolean => {
    const live = matrix();
    return positions.length > 0 && positions.every(([r, b]) => {
      const bit = (live[r] >> b) & 1;
      return activeLow ? bit === 0 : bit === 1;
    });
  };

  const releaseChord = (): void => {
    const kb = keyboard();
    if (kb) for (const [r, b] of chordCells) setKey(kb, r, b, false);
    chordCells = [];
    chordTimer = undefined;
  };

  const onDown = (positions: CellKey, latch?: LatchMode): void => {
    const kb = keyboard();
    if (!kb) return;
    if (!latch) {
      press(kb, positions, true);
      return;
    }

    const id = idOf(positions);
    const cur = latched();
    // Click an already-latched key again to unlatch it.
    if (cur.has(id)) {
      press(kb, positions, false);
      const next = new Map(cur);
      next.delete(id);
      setLatched(next);
      return;
    }

    // A second one-shot while another one-shot is already latched forms a
    // momentary chord (CAPS+SYMBOL → EXTEND MODE). Latching both keeps the chord
    // asserted forever, which makes the ROM auto-repeat the mode toggle it
    // flickers in and out; instead pulse both down together briefly and let go.
    if (latch === 'oneshot') {
      const others = [...cur.entries()].filter(([, e]) => !e.hold);
      if (others.length > 0) {
        const next = new Map(cur);
        const chord: LatchCell[] = [...positions];
        for (const [oid, e] of others) {
          next.delete(oid);              // drop the persistent latch...
          chord.push(...e.positions);    // ...but keep its bits asserted for the pulse
        }
        setLatched(next);
        press(kb, positions, true);
        chordCells = [...chordCells, ...chord];
        if (chordTimer) clearTimeout(chordTimer);
        chordTimer = setTimeout(releaseChord, chordPulseMs);
        return;
      }
    }

    // Normal latch on.
    press(kb, positions, true);
    const next = new Map(cur);
    next.set(id, { positions, hold: latch === 'hold' });
    setLatched(next);
  };

  const onUp = (positions: CellKey, latch?: LatchMode): void => {
    const kb = keyboard();
    if (!kb || latch) return;   // latched keys toggle on press only
    press(kb, positions, false);
    // Drop one-shot latches; leave 'hold' latches asserted.
    const map = latched();
    const next = new Map(map);
    let changed = false;
    for (const [id, entry] of map) {
      if (!entry.hold) {
        press(kb, entry.positions, false);
        next.delete(id);
        changed = true;
      }
    }
    if (changed) setLatched(next);
  };

  /** Let go of everything this controller asserted: a pending chord pulse and
   *  every latch. Runs when the pane closes (see the file header). */
  const releaseAll = (): void => {
    const kb = keyboard();
    if (chordTimer) { clearTimeout(chordTimer); chordTimer = undefined; }
    if (kb) {
      for (const [r, b] of chordCells) setKey(kb, r, b, false);
      for (const entry of latched().values()) press(kb, entry.positions, false);
    }
    chordCells = [];
    setLatched(new Map());
  };

  // Mirror once per animation frame while the pane is mounted, then release.
  let raf = 0;
  const frame = (): void => { poll(); raf = requestAnimationFrame(frame); };
  raf = requestAnimationFrame(frame);
  onCleanup(() => { cancelAnimationFrame(raf); releaseAll(); });

  return { isDown, onDown, onUp };
}
