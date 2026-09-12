/**
 * PCW keyboard.
 *
 * Unlike every other machine here, the PCW's keyboard is not read through a
 * port. The gate array scans it and writes the result straight into memory:
 * "The PCW's keyboard is directly mapped into the last 16 bytes of bank 3, even
 * when interrupts are disabled. Each key is reflected by one bit in bytes
 * &3FF0-&3FFA." Software just reads those bytes. So this class owns 16 bytes
 * and the machine copies them into physical block 3 as it scans.
 *
 * The matrix, from the Amstrad PCW Hardware Reference (bits b7 down to b0):
 *
 *   &3FF0   k2     k3     k6     k9     paste  f2     k0     f4
 *   &3FF1   k1     k5     k4     k8     copy   cut    ptr    exit
 *   &3FF2   [+]    1/2    shift  k7     #      return ]      del>
 *   &3FF3   .      /      ;      ¤      P      [      -      =
 *   &3FF4   ,      M      K      L      I      O      9      0
 *   &3FF5   space  N      J      H      Y      U      7      8
 *   &3FF6   V      B      F      G      T      R      5      6
 *   &3FF7   X      C      D      S      W      E      3      4
 *   &3FF8   Z      lock   A      tab    Q      stop   2      1
 *   &3FF9   del<   -      j1f1   j1f2   j1r    j1l    j1d    j1u
 *   &3FFA   alt    k.     enter  f8     [-]    can    extra  f6
 *
 * **Polarity: a pressed key SETS its bit, and an idle matrix is all zeros.**
 * The reference does not say, but the CP/M Plus XBIOS's own scan loop does —
 * it walks the 11 key bytes against the copy it kept from last time and picks
 * out the keys that have just gone down:
 *
 *     LD A,(DE)    ; this scan's byte
 *     LD C,A
 *     LD A,(HL)    ; last scan's byte
 *     LD (HL),C
 *     CPL
 *     AND C        ; bits set now and clear before = keys just pressed
 *
 * so "just pressed" is a 0 -> 1 edge. With an all-ones idle matrix every key
 * in the first two bytes appears to go down the instant the BIOS starts
 * scanning, and CP/M Plus types "96328451" at its own A> prompt.
 *
 * TODO(verify): **the cursor cluster.** The bytes above have no arrow keys in
 * them; the reference puts "cursor/matrix key bits" in the extended bytes
 * &3FFB-&3FFF but does not enumerate them. They are unmapped until sourced.
 */

import type { HostKeyEvent } from '@/machines/machine.ts';
import { PCW_KEYBOARD_BYTES } from './constants.ts';

/**
 * Whether a pressed key SETS its matrix bit (true) or CLEARS it (false).
 * Active high — see the polarity note above.
 */
const PRESSED_SETS_BIT = true;

/** The matrix byte value meaning "nothing pressed", for this polarity. */
const IDLE_BYTE = PRESSED_SETS_BIT ? 0x00 : 0xFF;

// The last four bytes are not plain key bits. Their low six bits are the
// joystick-style key combinations (so they idle unpressed like any other key),
// but bits 6 and 7 report the keyboard's option links and its transmit state:
//
//   &3FFD  b7 ~LK2 (1 = LK2 absent)      b6 SHIFT LOCK LED (1 = lit)
//   &3FFE  b7 LK3 present                b6 LK1 present — and LK1 puts the
//                                           keyboard into its self-test mode,
//                                           so this must read 0 on a normal
//                                           machine or the BIOS ignores us
//   &3FFF  b7 1 = transmitting, 0 = scanning
//          b6 toggles on every update the keyboard sends to the PCW
//
// All three links are disconnected by default, which is the machine modelled
// here. The b6 toggle on &3FFF is the keyboard's heartbeat: software watches it
// to tell a live keyboard from a dead one.
const STATUS_BYTE = 0x0D;
const LINK_BYTE = 0x0E;
const UPDATE_BYTE = 0x0F;
const STATUS_ALWAYS_SET = 0x80;   // &3FFD b7: LK2 absent
const STATUS_SHIFT_LOCK = 0x40;
const UPDATE_TOGGLE = 0x40;       // &3FFF b6

/** Where a key sits in the matrix, as [byte index from &3FF0, bit number]. */
type Cell = readonly [number, number];

/** Host `KeyboardEvent.code` to matrix position. */
const KEY_MAP: Record<string, Cell> = {
  // &3FF0 — numeric pad and function keys
  Numpad2: [0x0, 7], Numpad3: [0x0, 6], Numpad6: [0x0, 5], Numpad9: [0x0, 4],
  F2: [0x0, 2], Numpad0: [0x0, 1], F4: [0x0, 0],

  // &3FF1
  Numpad1: [0x1, 7], Numpad5: [0x1, 6], Numpad4: [0x1, 5], Numpad8: [0x1, 4],

  // &3FF2 — shift, RETURN and the right-hand punctuation
  NumpadAdd: [0x2, 7], Backquote: [0x2, 6],
  ShiftLeft: [0x2, 5], ShiftRight: [0x2, 5], Numpad7: [0x2, 4],
  Backslash: [0x2, 3],
  Enter: [0x2, 2], BracketRight: [0x2, 1], Delete: [0x2, 0],

  // &3FF3
  Period: [0x3, 7], Slash: [0x3, 6], Semicolon: [0x3, 5],
  KeyP: [0x3, 3], BracketLeft: [0x3, 2], Minus: [0x3, 1], Equal: [0x3, 0],

  // &3FF4
  Comma: [0x4, 7], KeyM: [0x4, 6], KeyK: [0x4, 5], KeyL: [0x4, 4],
  KeyI: [0x4, 3], KeyO: [0x4, 2], Digit9: [0x4, 1], Digit0: [0x4, 0],

  // &3FF5
  Space: [0x5, 7], KeyN: [0x5, 6], KeyJ: [0x5, 5], KeyH: [0x5, 4],
  KeyY: [0x5, 3], KeyU: [0x5, 2], Digit7: [0x5, 1], Digit8: [0x5, 0],

  // &3FF6
  KeyV: [0x6, 7], KeyB: [0x6, 6], KeyF: [0x6, 5], KeyG: [0x6, 4],
  KeyT: [0x6, 3], KeyR: [0x6, 2], Digit5: [0x6, 1], Digit6: [0x6, 0],

  // &3FF7
  KeyX: [0x7, 7], KeyC: [0x7, 6], KeyD: [0x7, 5], KeyS: [0x7, 4],
  KeyW: [0x7, 3], KeyE: [0x7, 2], Digit3: [0x7, 1], Digit4: [0x7, 0],

  // &3FF8 — STOP stands in for Escape, LOCK for Caps Lock
  KeyZ: [0x8, 7], CapsLock: [0x8, 6], KeyA: [0x8, 5], Tab: [0x8, 4],
  KeyQ: [0x8, 3], Escape: [0x8, 2], Digit2: [0x8, 1], Digit1: [0x8, 0],

  // &3FF9 — DEL< is the backspace key; EXTRA takes Alt
  Backspace: [0x9, 7],

  // &3FFA — ALT is the PCW's control key, so it takes host Control
  ControlLeft: [0xA, 7], ControlRight: [0xA, 7],
  NumpadDecimal: [0xA, 6], NumpadEnter: [0xA, 5], F8: [0xA, 4],
  NumpadSubtract: [0xA, 3], AltLeft: [0xA, 1], AltRight: [0xA, 1], F6: [0xA, 0],
};

export class PcwKeyboard {
  /** The 16 bytes the gate array writes to &3FF0-&3FFF of block 3. */
  readonly matrix = new Uint8Array(PCW_KEYBOARD_BYTES);

  /** Host keys currently held, so a repeat event cannot double-release. */
  private readonly held = new Set<string>();

  /** SHIFT LOCK is a latching key on the PCW; the host's Caps Lock toggles it. */
  shiftLock = false;

  /** &3FFF b6, flipped on every scan copied to the PCW — the keyboard's
   *  heartbeat, which software watches to tell a live keyboard from a dead one. */
  private updateToggle = false;

  /** True while any mapped key is held — the status bar's keyboard LED. */
  get anyKeyDown(): boolean { return this.held.size > 0; }

  constructor() {
    this.reset();
  }

  reset(): void {
    this.held.clear();
    this.shiftLock = false;
    this.matrix.fill(IDLE_BYTE);
    this.refreshStatus();
  }

  /** Apply a host key event. Returns true when the key belongs to this
   *  machine, so the caller knows to swallow it. */
  handleKeyEvent(e: HostKeyEvent, down: boolean): boolean {
    const cell = KEY_MAP[e.code];
    if (!cell) return false;

    if (down) {
      if (this.held.has(e.code)) return true;
      this.held.add(e.code);
    } else if (!this.held.delete(e.code)) {
      return true;
    }

    const [byte, bit] = cell;
    const mask = 1 << bit;
    if (down === PRESSED_SETS_BIT) this.matrix[byte] |= mask;
    else this.matrix[byte] &= ~mask;

    if (e.code === 'CapsLock' && down) this.shiftLock = !this.shiftLock;
    this.refreshStatus();
    return true;
  }

  /** Keep &3FFD's fixed and SHIFT LOCK bits in step. */
  private refreshStatus(): void {
    // b7 and b6 are status, not keys; the rest of each byte holds key
    // combinations and so idles at the unpressed level for the polarity.
    const rest = IDLE_BYTE & 0x3F;
    this.matrix[STATUS_BYTE] =
      rest | STATUS_ALWAYS_SET | (this.shiftLock ? STATUS_SHIFT_LOCK : 0);
    // No option links fitted, so both of &3FFE's flag bits read low.
    this.matrix[LINK_BYTE] = rest;
    this.matrix[UPDATE_BYTE] = rest | (this.updateToggle ? UPDATE_TOGGLE : 0);
  }

  /**
   * Copy the matrix into physical block 3, which is what the gate array's DMA
   * does. Called once per scan by the machine, so software reading &3FF0 sees
   * a fresh matrix whether or not interrupts are enabled.
   */
  writeInto(block3: Uint8Array, offset: number): void {
    // Each copy is one transmission from keyboard to PCW, and &3FFF b6 flips
    // with every one — that alternation is how software sees a live keyboard.
    this.updateToggle = !this.updateToggle;
    this.refreshStatus();
    block3.set(this.matrix, offset);
  }
}
