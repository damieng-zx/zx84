/**
 * PCW joystick interfaces.
 *
 * The PCW's keyboard matrix has joystick entries (J1 in &3FF9, J2 in &3FFB),
 * but no PCW keyboard ever had a socket for them — "Existing PCWs have no
 * provision for connecting a joystick to the keyboard" (John Elliott, PCW
 * hardware guide §10.3); they are left over from the design the PCW grew out
 * of. So those bits stay idle. Joysticks reached a PCW through add-on
 * interfaces on the expansion bus, each read through its own I/O port (guide
 * §12):
 *
 *   Kempston      port &9F, active high: b4 fire, b3 down, b2 up, b1 left,
 *                 b0 right (the Spectrum interface's layout)
 *   Spectravideo  port &E0, active high: b7 always 0, b4 right, b3 up, b2
 *                 left, b1 fire, b0 down
 *   Cascade       port &E0 (the JoyceStick; Head over Heels's driver), active
 *                 low: b7 fire, b4 up, b2 down, b1 right, b0 left
 *
 * One interface is fitted at a time (Spectravideo and Cascade share a port),
 * chosen in the Joystick pane. Bits the guide lists as unused read 0 on the
 * active-high interfaces and 1 on the Cascade. The DKTronics interface, a port
 * of the DKTronics sound board's AY, is not offered: that board is not
 * emulated.
 */

export type PcwJoystickType = 'kempston' | 'spectravideo' | 'cascade' | 'none';

export const PCW_KEMPSTON_PORT = 0x9F;
export const PCW_JOYSTICK_E0_PORT = 0xE0;

export class PcwJoystick {
  type: PcwJoystickType = 'kempston';
  private up = false;
  private down = false;
  private left = false;
  private right = false;
  private fire = false;

  /** Set the fitted interface from the `joy-p1` setting; a value that names
   *  another machine's interface (the Spectrum's Cursor or Sinclair) means
   *  the default, Kempston — which is what the pane's selector then shows. */
  setType(type: string): void {
    this.type = type === 'none' || type === 'spectravideo' || type === 'cascade' ? type : 'kempston';
  }

  press(dir: string, pressed: boolean): void {
    switch (dir) {
      case 'up': this.up = pressed; break;
      case 'down': this.down = pressed; break;
      case 'left': this.left = pressed; break;
      case 'right': this.right = pressed; break;
      case 'fire': this.fire = pressed; break;
      default: break;
    }
  }

  release(): void {
    this.up = this.down = this.left = this.right = this.fire = false;
  }

  /** The byte the fitted interface returns on `port` (low byte), or null
   *  when no interface answers there. */
  read(port: number): number | null {
    if (port === PCW_KEMPSTON_PORT && this.type === 'kempston') {
      return (this.fire ? 0x10 : 0) | (this.down ? 0x08 : 0) | (this.up ? 0x04 : 0)
        | (this.left ? 0x02 : 0) | (this.right ? 0x01 : 0);
    }
    if (port === PCW_JOYSTICK_E0_PORT && this.type === 'spectravideo') {
      return (this.right ? 0x10 : 0) | (this.up ? 0x08 : 0) | (this.left ? 0x04 : 0)
        | (this.fire ? 0x02 : 0) | (this.down ? 0x01 : 0);
    }
    if (port === PCW_JOYSTICK_E0_PORT && this.type === 'cascade') {
      let v = 0xFF;
      if (this.fire) v &= ~0x80;
      if (this.up) v &= ~0x10;
      if (this.down) v &= ~0x04;
      if (this.right) v &= ~0x02;
      if (this.left) v &= ~0x01;
      return v;
    }
    return null;
  }
}
