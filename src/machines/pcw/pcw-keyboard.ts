/**
 * PCW keyboard.
 *
 * Unlike every other machine here, the PCW's keyboard is not read through a
 * port. The keyboard's own controller scans the keys and sends the result to
 * the gate array, which writes it into the top sixteen bytes of block 3 —
 * "Data from the keyboard is written automatically into a table occupying the
 * top sixteen bytes of block 3 of the standard RAM" (Amstrad spec §9).
 * Software just reads those bytes. So this class owns 16 bytes and the memory
 * overlays them on block 3's &3FF0-&3FFF.
 *
 * The key bytes, from John Elliott's PCW hardware guide §10 (bits b7 to b0;
 * "kp" is the right-hand pad, J1/J2 the keyboard joysticks no PCW keyboard has
 * a socket for):
 *
 *   &3FF0   kp2    kp3    kp6    kp9    PASTE  f1/f2  kp0    f3/f4
 *   &3FF1   kp1    kp5    kp4    kp8    COPY   CUT    PTR    EXIT
 *   &3FF2   [+]    1/2    SHIFT  kp7    >      RETURN ]      DEL>
 *   &3FF3   .      ?      ;      <      P      [      -      =
 *   &3FF4   ,      M      K      L      I      O      9      0
 *   &3FF5   SPACE  N      J      H      Y      U      7      8
 *   &3FF6   V      B      F      G      T      R      5      6
 *   &3FF7   X      C      D      S      W      E      3      4
 *   &3FF8   Z      LOCK   A      TAB    Q      STOP   2      1
 *   &3FF9   <DEL   -      J1f1   J1f2   J1rt   J1lt   J1dn   J1up
 *   &3FFA   ALT    kp.    ENTER  f7/f8  [-]    CAN    EXTRA  f5/f6
 *   &3FFB   -      -      J2f1   J2f2   J2rt   J2lt   J2dn   J2up
 *
 * (The guide's &3FF6 b1 reads "S", a typo for 5: S is &3FF7 b4.) The keys are
 * named by the caps on the 8000-series deck; `ui/keyboard/layout.ts` has the
 * full legends. The pad keys carry the cursor arrows on their tops: ↑ is kp5,
 * ← kp1, → kp3 and ↓ kp., round kp2 — which is also the diamond the keyboard
 * reports in &3FFD's joystick bits below.
 *
 * The last four bytes carry the keyboard's status in b7-6, and in b5-0 the
 * same keys gathered into joystick-shaped groups by the keyboard controller,
 * bits ordered as the J1/J2 entries are (b5 fire 1, b4 fire 2, b3 right,
 * b2 left, b1 down, b0 up). From the same table:
 *
 *   &3FFC   b5 kp ENTER, b4 SPACE, b3 kp0, b2 EXIT, b1 f1/f2, b0 f3/f4 — an
 *           inverted T round f1. (With link LK2, which is not fitted here,
 *           SHIFT/S/D/A/X/W instead.)
 *   &3FFD   b7 ~LK2, b6 SHIFT LOCK LED; b5 SPACE, b4 kp2, b3 kp3, b2 kp1,
 *           b1 kp., b0 kp5 — the pad.
 *   &3FFE   b7 LK3, b6 LK1; b5 SHIFT, b4 SPACE, b3 W R P ] ; > . 1/2,
 *           b2 Q E O [ L < , /, b1 Z X C V B N M, b0 A S D F G H J.
 *   &3FFF   b7 transmitting, b6 update toggle; b5 SHIFT, b4 SPACE,
 *           b3 W R P ] S F X V, b2 Q E O [ A D Z C, b1 B N M , . / 1/2,
 *           b0 H J K L ; < >.
 *
 * The guide prints &3FFF b3 as "WRP[" — "[" is already in b2, and every other
 * group splits the top row Q/W, E/R, O/P, [/] between left and right, so it
 * is taken as "]" here.
 *
 * **Polarity: a pressed key SETS its bit, and an idle matrix is all zeros**
 * (the guide: "If no keyboard is present, all 16 bytes of the memory map are
 * zero"). The CP/M Plus XBIOS's own scan loop agrees — it walks the key bytes
 * against the copy it kept from last time and picks out the keys that have
 * just gone down:
 *
 *     LD A,(DE)    ; this scan's byte
 *     LD C,A
 *     LD A,(HL)    ; last scan's byte
 *     LD (HL),C
 *     CPL
 *     AND C        ; bits set now and clear before = keys just pressed
 *
 * so "just pressed" is a 0 -> 1 edge.
 */

import type { StateReader, StateWriter } from '@/machines/shared/state-io.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';
import { PCW_KEYBOARD_BYTES } from './constants.ts';

/** Where a key sits in the matrix, as [byte index from &3FF0, bit number]. */
export type PcwCell = readonly [byte: number, bit: number];
type Cell = PcwCell;

// ── Named cells (byte from &3FF0, bit) ───────────────────────────────────────

const SHIFT: Cell = [0x2, 5];
const SPACE: Cell = [0x5, 7];
const SHIFT_LOCK: Cell = [0x8, 6];
const F1_F2: Cell = [0x0, 2];
const F3_F4: Cell = [0x0, 0];
const F5_F6: Cell = [0xA, 0];
const F7_F8: Cell = [0xA, 4];
const KP: Record<string, Cell> = {
  '0': [0x0, 1], '1': [0x1, 7], '2': [0x0, 7], '3': [0x0, 6], '4': [0x1, 5],
  '5': [0x1, 6], '6': [0x0, 5], '7': [0x2, 4], '8': [0x1, 4], '9': [0x0, 4],
  '.': [0xA, 6], enter: [0xA, 5],
};
const EXIT: Cell = [0x1, 0];
const PTR: Cell = [0x1, 1];
const CUT: Cell = [0x1, 2];
const COPY: Cell = [0x1, 3];
const PASTE: Cell = [0x0, 3];
const CAN: Cell = [0xA, 2];
const PLUS: Cell = [0x2, 7];
const MINUS: Cell = [0xA, 3];
const ALT: Cell = [0xA, 7];
const EXTRA: Cell = [0xA, 1];

/** The main-block keys the joystick groups are made of, by legend. */
const K: Record<string, Cell> = {
  A: [0x8, 5], B: [0x6, 6], C: [0x7, 6], D: [0x7, 5], E: [0x7, 2], F: [0x6, 5],
  G: [0x6, 4], H: [0x5, 4], J: [0x5, 5], K: [0x4, 5], L: [0x4, 4], M: [0x4, 6],
  N: [0x5, 6], O: [0x4, 2], P: [0x3, 3], Q: [0x8, 3], R: [0x6, 2], S: [0x7, 4],
  V: [0x6, 7], W: [0x7, 3], X: [0x7, 7], Z: [0x8, 7],
  ']': [0x2, 1], '[': [0x3, 2], ';': [0x3, 5], '>': [0x2, 3], '<': [0x3, 4],
  '.': [0x3, 7], ',': [0x4, 7], '/': [0x3, 6], half: [0x2, 6],
};
const keys = (...names: string[]): Cell[] => names.map(n => K[n]);

/**
 * The joystick-shaped groups in &3FFC-&3FFF, as [byte, bit, member keys]: the
 * bit is set while any member is down. LK2's alternative &3FFC map is not
 * here because LK2 is not fitted.
 */
const GROUPS: readonly (readonly [number, number, readonly Cell[]])[] = [
  [0xC, 5, [KP.enter]], [0xC, 4, [SPACE]], [0xC, 3, [KP['0']]],
  [0xC, 2, [EXIT]], [0xC, 1, [F1_F2]], [0xC, 0, [F3_F4]],

  [0xD, 5, [SPACE]], [0xD, 4, [KP['2']]], [0xD, 3, [KP['3']]],
  [0xD, 2, [KP['1']]], [0xD, 1, [KP['.']]], [0xD, 0, [KP['5']]],

  [0xE, 5, [SHIFT]], [0xE, 4, [SPACE]],
  [0xE, 3, keys('W', 'R', 'P', ']', ';', '>', '.', 'half')],
  [0xE, 2, keys('Q', 'E', 'O', '[', 'L', '<', ',', '/')],
  [0xE, 1, keys('Z', 'X', 'C', 'V', 'B', 'N', 'M')],
  [0xE, 0, keys('A', 'S', 'D', 'F', 'G', 'H', 'J')],

  [0xF, 5, [SHIFT]], [0xF, 4, [SPACE]],
  [0xF, 3, keys('W', 'R', 'P', ']', 'S', 'F', 'X', 'V')],
  [0xF, 2, keys('Q', 'E', 'O', '[', 'A', 'D', 'Z', 'C')],
  [0xF, 1, keys('B', 'N', 'M', ',', '.', '/', 'half')],
  [0xF, 0, keys('H', 'J', 'K', 'L', ';', '<', '>')],
];

// Status bits in b7-6 of the last bytes.
const STATUS_BYTE = 0x0D;
const LINK_BYTE = 0x0E;
const UPDATE_BYTE = 0x0F;
/** &3FFD b7: 0 if link LK2 is fitted. It is not. */
const STATUS_NO_LK2 = 0x80;
/** &3FFD b6: the SHIFT LOCK LED. */
const STATUS_SHIFT_LOCK = 0x40;
/** &3FFF b6: toggles with each update the keyboard sends. (b7, "transmitting",
 *  reads 0: the update is copied in at one instant here.) &3FFE b7/b6 are links
 *  LK3 and LK1, both absent — LK1 would put the keyboard into its self-test. */
const UPDATE_TOGGLE = 0x40;

/**
 * Host `KeyboardEvent.code` to the cells it presses. A host key may press two:
 * the PCW's function keys are paired on four caps with SHIFT choosing the
 * higher of each pair (f1 unshifted, f2 shifted), so F2 is the f1/f2 cap with
 * SHIFT.
 */
const KEY_MAP: Record<string, readonly Cell[]> = {
  // &3FF0-&3FF1 and the rest of the pad. The arrows are the pad caps that
  // carry them.
  Numpad0: [KP['0']], Numpad1: [KP['1']], Numpad2: [KP['2']], Numpad3: [KP['3']],
  Numpad4: [KP['4']], Numpad5: [KP['5']], Numpad6: [KP['6']], Numpad7: [KP['7']],
  Numpad8: [KP['8']], Numpad9: [KP['9']], NumpadDecimal: [KP['.']],
  NumpadEnter: [KP.enter],
  ArrowUp: [KP['5']], ArrowLeft: [KP['1']], ArrowRight: [KP['3']], ArrowDown: [KP['.']],

  // The function keys.
  F1: [F1_F2], F2: [F1_F2, SHIFT], F3: [F3_F4], F4: [F3_F4, SHIFT],
  F5: [F5_F6], F6: [F5_F6, SHIFT], F7: [F7_F8], F8: [F7_F8, SHIFT],

  // The editing caps, on the host's editing block.
  Home: [PTR], End: [EXIT], F9: [CUT], F10: [COPY], Insert: [PASTE], Pause: [CAN],
  NumpadAdd: [PLUS], PageUp: [PLUS], NumpadSubtract: [MINUS], PageDown: [MINUS],

  // &3FF2 — shift, RETURN and the right-hand punctuation
  Backquote: [K.half], ShiftLeft: [SHIFT], ShiftRight: [SHIFT],
  Backslash: [K['>']], Enter: [[0x2, 2]], BracketRight: [K[']']], Delete: [[0x2, 0]],

  // &3FF3
  Period: [K['.']], Slash: [K['/']], Semicolon: [K[';']], IntlBackslash: [K['<']],
  KeyP: [K.P], BracketLeft: [K['[']], Minus: [[0x3, 1]], Equal: [[0x3, 0]],

  // &3FF4
  Comma: [K[',']], KeyM: [K.M], KeyK: [K.K], KeyL: [K.L],
  KeyI: [[0x4, 3]], KeyO: [K.O], Digit9: [[0x4, 1]], Digit0: [[0x4, 0]],

  // &3FF5
  Space: [SPACE], KeyN: [K.N], KeyJ: [K.J], KeyH: [K.H],
  KeyY: [[0x5, 3]], KeyU: [[0x5, 2]], Digit7: [[0x5, 1]], Digit8: [[0x5, 0]],

  // &3FF6
  KeyV: [K.V], KeyB: [K.B], KeyF: [K.F], KeyG: [K.G],
  KeyT: [[0x6, 3]], KeyR: [K.R], Digit5: [[0x6, 1]], Digit6: [[0x6, 0]],

  // &3FF7
  KeyX: [K.X], KeyC: [K.C], KeyD: [K.D], KeyS: [K.S],
  KeyW: [K.W], KeyE: [K.E], Digit3: [[0x7, 1]], Digit4: [[0x7, 0]],

  // &3FF8 — STOP stands in for Escape, SHIFT LOCK for Caps Lock
  KeyZ: [K.Z], CapsLock: [SHIFT_LOCK], KeyA: [K.A], Tab: [[0x8, 4]],
  KeyQ: [K.Q], Escape: [[0x8, 2]], Digit2: [[0x8, 1]], Digit1: [[0x8, 0]],

  // &3FF9 — <DEL is the backspace key
  Backspace: [[0x9, 7]],

  // &3FFA — ALT is the PCW's control key, so it takes host Control; EXTRA
  // takes Alt
  ControlLeft: [ALT], ControlRight: [ALT], AltLeft: [EXTRA], AltRight: [EXTRA],
};

/** Matrix bytes that carry key bits (&3FF0-&3FFB). The last four are status
 *  and key groups, which `refreshDerived` owns. */
const KEY_BYTES = 0x0C;

export class PcwKeyboard {
  /** The 16 bytes the gate array writes to &3FF0-&3FFF of block 3. */
  readonly matrix = new Uint8Array(PCW_KEYBOARD_BYTES);

  /** How many presses hold each key cell (`byte * 8 + bit`): two host keys can
   *  share a cap (both SHIFTs, F1 and F2), and a host key and a pointer can
   *  hold the same one, so a cell is down until its last holder lets go. */
  private readonly holds = new Uint8Array(KEY_BYTES * 8);

  /** Host keys currently held, so a repeat event cannot double-press. */
  private readonly held = new Set<string>();

  /** Cells held by the on-screen keyboard, as `byte * 8 + bit`. */
  private readonly pointerHeld = new Set<number>();

  /** SHIFT LOCK is a latching key on the PCW; the host's Caps Lock toggles it. */
  shiftLock = false;

  /** &3FFF b6, flipped on every scan copied to the PCW — the keyboard's
   *  heartbeat, which software watches to tell a live keyboard from a dead one. */
  private updateToggle = false;

  /** True while any mapped key is held — the status bar's keyboard LED. */
  get anyKeyDown(): boolean {
    return this.held.size > 0 || this.pointerHeld.size > 0;
  }

  /** True while `cell` is pressed, whoever pressed it. */
  isCellDown([byte, bit]: Cell): boolean {
    return ((this.matrix[byte] >> bit) & 1) === 1;
  }

  /**
   * Press or release one matrix cell directly.
   *
   * The on-screen keyboard's route in, for caps the host keyboard lacks. SHIFT
   * LOCK latches here exactly as it does for the host's Caps Lock.
   */
  setCell([byte, bit]: Cell, down: boolean): void {
    if (byte < 0 || byte >= KEY_BYTES) return;
    const id = byte * 8 + bit;
    if (this.pointerHeld.has(id) === down) return;
    if (down) this.pointerHeld.add(id);
    else this.pointerHeld.delete(id);
    this.hold(id, down);
    if (down && byte === SHIFT_LOCK[0] && bit === SHIFT_LOCK[1]) this.shiftLock = !this.shiftLock;
    this.refreshDerived();
  }

  constructor() {
    this.reset();
  }

  reset(): void {
    this.held.clear();
    this.pointerHeld.clear();
    this.holds.fill(0);
    this.shiftLock = false;
    this.matrix.fill(0);
    this.refreshDerived();
  }

  /** Apply a host key event. Returns true when the key belongs to this
   *  machine, so the caller knows to swallow it. */
  handleKeyEvent(e: HostKeyEvent, down: boolean): boolean {
    const cells = KEY_MAP[e.code];
    if (!cells) return false;

    if (down) {
      if (this.held.has(e.code)) return true;
      this.held.add(e.code);
    } else if (!this.held.delete(e.code)) {
      return true;
    }

    for (const [byte, bit] of cells) this.hold(byte * 8 + bit, down);
    if (e.code === 'CapsLock' && down) this.shiftLock = !this.shiftLock;
    this.refreshDerived();
    return true;
  }

  /** Count one press or release of cell `id`, setting its bit while held. */
  private hold(id: number, down: boolean): void {
    const n = this.holds[id];
    if (down) this.holds[id] = n + 1;
    else if (n > 0) this.holds[id] = n - 1;
    const byte = id >> 3;
    const mask = 1 << (id & 7);
    if (this.holds[id] > 0) this.matrix[byte] |= mask;
    else this.matrix[byte] &= ~mask;
  }

  /** Rebuild &3FFC-&3FFF: the key groups from the key bits, and the status. */
  private refreshDerived(): void {
    const m = this.matrix;
    m[0xC] = 0;
    m[STATUS_BYTE] = STATUS_NO_LK2 | (this.shiftLock ? STATUS_SHIFT_LOCK : 0);
    m[LINK_BYTE] = 0;
    m[UPDATE_BYTE] = this.updateToggle ? UPDATE_TOGGLE : 0;
    for (const [byte, bit, members] of GROUPS) {
      for (const [b, k] of members) {
        if (m[b] & (1 << k)) { m[byte] |= 1 << bit; break; }
      }
    }
  }

  /**
   * One keyboard-to-PCW transmission. &3FFF b6 flips with every one — that
   * alternation is how software sees a live keyboard. The matrix itself is
   * read live: the memory overlays it on block 3's &3FF0-&3FFF.
   */
  scan(): void {
    this.updateToggle = !this.updateToggle;
    this.refreshDerived();
  }

  /** The keyboard's own latches: SHIFT LOCK and the &3FFF update toggle.
   *  Which keys are held is the host's, not state. */
  saveState(w: StateWriter): void {
    w.bool(this.shiftLock);
    w.bool(this.updateToggle);
  }

  /** Restore the latches with every key released. */
  loadState(r: StateReader): void {
    this.reset();
    this.shiftLock = r.bool();
    this.updateToggle = r.bool();
    this.refreshDerived();
  }

  /** Scan, then copy the matrix into a block buffer at `offset` (a snapshot
   *  of what CPU reads of &3FF0-&3FFF see). */
  writeInto(block3: Uint8Array, offset: number): void {
    this.scan();
    block3.set(this.matrix, offset);
  }
}
