/**
 * Memotech MTX keyboard: 8 drive lines by 10 sense lines, active low.
 *
 * Port 5 writes the drive mask and reads sense lines 0-7. Port 6 reads sense
 * lines 8-9 plus the two-bit country code. Multiple selected drive lines are
 * ANDed, matching the keyboard diodes and ROM scanning routine.
 */

type Cell = readonly [drive: number, sense: number];

// Both Atari-style joystick sockets are wired in parallel with the keyboard.
// The preferred right socket shadows the cursor/Home keys; the left socket
// shadows the Z/C/B/M/Space cluster.
const JOYSTICK_MAP: readonly Record<string, Cell>[] = [
  {
    left: [3, 7], right: [4, 7], up: [2, 7], down: [6, 7], fire: [5, 7],
  },
  {
    left: [7, 0], right: [7, 1], up: [7, 2], down: [7, 3], fire: [7, 8],
  },
];

const KEY_MAP: Record<string, Cell> = {
  Digit1: [0, 0], Digit2: [1, 1], Digit3: [0, 1], Digit4: [1, 2],
  Digit5: [0, 2], Digit6: [1, 3], Digit7: [0, 3], Digit8: [1, 4],
  Digit9: [0, 4], Digit0: [1, 5],

  KeyA: [5, 0], KeyB: [7, 2], KeyC: [7, 1], KeyD: [5, 1],
  KeyE: [3, 1], KeyF: [4, 2], KeyG: [5, 2], KeyH: [4, 3],
  KeyI: [2, 4], KeyJ: [5, 3], KeyK: [4, 4], KeyL: [5, 4],
  KeyM: [7, 3], KeyN: [6, 3], KeyO: [3, 4], KeyP: [2, 5],
  KeyQ: [3, 0], KeyR: [2, 2], KeyS: [4, 1], KeyT: [3, 2],
  KeyU: [3, 3], KeyV: [6, 2], KeyW: [2, 1], KeyX: [6, 1],
  KeyY: [2, 3], KeyZ: [7, 0],

  Escape: [1, 0], Backspace: [1, 8], Tab: [2, 8], Enter: [5, 6],
  Space: [7, 8], ShiftLeft: [6, 0], ShiftRight: [6, 6],
  ControlLeft: [2, 0], ControlRight: [2, 0], CapsLock: [4, 0],

  Minus: [0, 5], Equal: [1, 6], Backslash: [0, 6],
  BracketLeft: [2, 6], BracketRight: [4, 6], Semicolon: [4, 5],
  Quote: [3, 5], Comma: [6, 4], Period: [7, 4], Slash: [6, 5],

  ArrowLeft: [3, 7], ArrowRight: [4, 7], ArrowUp: [2, 7],
  ArrowDown: [6, 7], Home: [5, 7], Insert: [7, 6], Delete: [3, 8],
  PageUp: [0, 7], PageDown: [7, 7],

  F1: [0, 9], F2: [2, 9], F3: [5, 9], F4: [7, 9],
  F5: [1, 9], F6: [3, 9], F7: [4, 9], F8: [6, 9],
};

export class MtxKeyboard {
  /** Ten active-low sense bits for each of the eight drive lines. */
  private readonly matrix = new Uint16Array(8).fill(0x03FF);
  private readonly joystickMatrix = new Uint16Array(8).fill(0x03FF);
  private driveMask = 0xFF;

  selectDrive(mask: number): void {
    this.driveMask = mask & 0xFF;
  }

  readSenseLow(): number {
    return this.selectedSense() & 0xFF;
  }

  readSenseHigh(): number {
    // English country code = 00 on bits 2-3. Bits 4-7 are pulled low on the
    // original board; sense lines 8-9 occupy bits 0-1.
    return (this.selectedSense() >> 8) & 0x03;
  }

  handleKeyEvent(code: string, pressed: boolean): boolean {
    const cell = KEY_MAP[code];
    if (!cell) return false;
    this.setKey(cell[0], cell[1], pressed);
    return true;
  }

  setKey(drive: number, sense: number, pressed: boolean): void {
    if (drive < 0 || drive >= 8 || sense < 0 || sense >= 10) return;
    const bit = 1 << sense;
    if (pressed) this.matrix[drive] &= ~bit & 0x03FF;
    else this.matrix[drive] |= bit;
  }

  setJoystick(direction: string, pressed: boolean, player: number): void {
    const cell = JOYSTICK_MAP[player]?.[direction];
    if (!cell) return;
    const bit = 1 << cell[1];
    if (pressed) this.joystickMatrix[cell[0]] &= ~bit & 0x03FF;
    else this.joystickMatrix[cell[0]] |= bit;
  }

  reset(): void {
    this.matrix.fill(0x03FF);
    this.joystickMatrix.fill(0x03FF);
    this.driveMask = 0xFF;
  }

  private selectedSense(): number {
    let result = 0x03FF;
    for (let drive = 0; drive < 8; drive++) {
      if ((this.driveMask & (1 << drive)) === 0) {
        result &= this.matrix[drive] & this.joystickMatrix[drive];
      }
    }
    return result;
  }
}
