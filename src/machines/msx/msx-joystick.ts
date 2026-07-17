/**
 * MsxJoystick — the two Atari-style joystick ports of the MSX.
 *
 * Both ports are read through the PSG: the program writes PSG register 15 (I/O
 * port B) with bit 6 selecting which port to read, then reads PSG register 14
 * (I/O port A). Register 14, for the selected port, is active-low:
 *
 *   bit 0 up   bit 1 down   bit 2 left   bit 3 right
 *   bit 4 trigger A (button 1)   bit 5 trigger B (button 2)
 *   bit 6 pin-8 input   bit 7 cassette input
 *
 * Bits 6/7 are left high here (pin-8 idle, cassette idle — cassette loads via
 * the BIOS trap in msx-tape.ts, not this bit). The `mode`/type used by the
 * Spectrum joystick is irrelevant on the MSX: the player index picks the port.
 */

interface PortState {
  up: boolean; down: boolean; left: boolean; right: boolean;
  trigA: boolean; trigB: boolean;
}

const newPort = (): PortState => ({ up: false, down: false, left: false, right: false, trigA: false, trigB: false });

export class MsxJoystick {
  private readonly ports: [PortState, PortState] = [newPort(), newPort()];

  /** Port selected for reading (PSG reg 15 bit 6): 0 = port 1, 1 = port 2. */
  private selected = 0;

  /** PSG register 15 write — bit 6 selects the joystick port to read. */
  setSelect(reg15: number): void { this.selected = (reg15 >> 6) & 1; }

  /** PSG register 14 read for the currently selected port (active-low). */
  read(): number {
    const s = this.ports[this.selected];
    let v = 0xFF;
    if (s.up) v &= ~0x01;
    if (s.down) v &= ~0x02;
    if (s.left) v &= ~0x04;
    if (s.right) v &= ~0x08;
    if (s.trigA) v &= ~0x10;
    if (s.trigB) v &= ~0x20;
    return v & 0xFF;
  }

  /** Set a direction/button for a player (0 = port 1, 1 = port 2). `dir` is the
   *  shared joystick vocabulary: up/down/left/right/fire[1]/fire2. */
  set(dir: string, pressed: boolean, player = 0): void {
    const s = this.ports[player & 1];
    switch (dir) {
      case 'up': s.up = pressed; break;
      case 'down': s.down = pressed; break;
      case 'left': s.left = pressed; break;
      case 'right': s.right = pressed; break;
      case 'fire': case 'fire1': s.trigA = pressed; break;
      case 'fire2': s.trigB = pressed; break;
    }
  }

  /** True if any direction or button on either port is currently active. */
  get active(): boolean {
    return this.ports.some(s => s.up || s.down || s.left || s.right || s.trigA || s.trigB);
  }

  reset(): void {
    this.ports[0] = newPort();
    this.ports[1] = newPort();
    this.selected = 0;
  }
}
