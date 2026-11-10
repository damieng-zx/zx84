/**
 * The 8563 VDC's register file, RAM and block copy/fill, as far as the KERNAL's
 * start-up needs them: no display yet (the 80-column display is a later phase),
 * and a block operation finishes at once. The chip has two ports: $D600
 * selects a register (a read gives the status: bit 7 is set when the chip is
 * ready, and the low bits are its version), $D601 reads or writes the
 * selected register. Registers 18 and 19
 * are the update address and register 31 the data port: a read or write there
 * goes to the VDC's RAM at that address, which then moves on by one. The
 * 16K of RAM wraps; a machine fitted with 64K would not.
 *
 * Block operations: writing the word-count register (30) copies or fills that
 * many bytes (0 is 256) from the update address on. With bit 7 of register 24
 * set it copies, from the block start address (registers 32 and 33); otherwise
 * it fills with the byte last written to the data port, so a fill is "write
 * the first byte through register 31, then the count less one to register 30".
 */

const VDC_REGISTERS = 38;
const VDC_RAM_SIZE = 0x4000;
/** The register that is the data port. */
const REG_DATA = 31;
const REG_UPDATE_HI = 18;
const REG_UPDATE_LO = 19;
const REG_COPY = 24;
const REG_COUNT = 30;
const REG_SOURCE_HI = 32;
const REG_SOURCE_LO = 33;

export class Vdc {
  readonly regs = new Uint8Array(VDC_REGISTERS);
  readonly ram = new Uint8Array(VDC_RAM_SIZE);
  private selected = 0;
  /** The byte last passed through the data port (what a fill writes). */
  private dataByte = 0;

  reset(): void {
    this.regs.fill(0);
    this.ram.fill(0);
    this.selected = 0;
    this.dataByte = 0;
  }

  private get updateAddress(): number { return (this.regs[REG_UPDATE_HI] << 8) | this.regs[REG_UPDATE_LO]; }
  private set updateAddress(a: number) {
    this.regs[REG_UPDATE_HI] = (a >> 8) & 0xFF;
    this.regs[REG_UPDATE_LO] = a & 0xFF;
  }

  /** A read of $D600 (port 0, the status) or $D601 (port 1, the register). */
  read(port: number): number {
    if ((port & 1) === 0) return 0x80;                 // ready; version 0
    if (this.selected === REG_DATA) {
      const a = this.updateAddress;
      this.updateAddress = (a + 1) & 0xFFFF;
      this.dataByte = this.ram[a & (VDC_RAM_SIZE - 1)];
      return this.dataByte;
    }
    return this.selected < VDC_REGISTERS ? this.regs[this.selected] : 0xFF;
  }

  /** What a read would give, without moving the update address. */
  peek(port: number): number {
    if ((port & 1) === 0) return 0x80;
    if (this.selected === REG_DATA) return this.ram[this.updateAddress & (VDC_RAM_SIZE - 1)];
    return this.selected < VDC_REGISTERS ? this.regs[this.selected] : 0xFF;
  }

  write(port: number, value: number): void {
    const v = value & 0xFF;
    if ((port & 1) === 0) { this.selected = v & 0x3F; return; }
    if (this.selected === REG_DATA) {
      const a = this.updateAddress;
      this.ram[a & (VDC_RAM_SIZE - 1)] = v;
      this.dataByte = v;
      this.updateAddress = (a + 1) & 0xFFFF;
    } else if (this.selected < VDC_REGISTERS) {
      this.regs[this.selected] = v;
      if (this.selected === REG_COUNT) this.blockOperation(v === 0 ? 256 : v);
    }
  }

  /** Copy or fill `count` bytes from the update address on. */
  private blockOperation(count: number): void {
    const mask = VDC_RAM_SIZE - 1;
    let dst = this.updateAddress;
    if ((this.regs[REG_COPY] & 0x80) !== 0) {
      let src = (this.regs[REG_SOURCE_HI] << 8) | this.regs[REG_SOURCE_LO];
      for (let i = 0; i < count; i++) {
        this.ram[dst & mask] = this.ram[src & mask];
        dst = (dst + 1) & 0xFFFF;
        src = (src + 1) & 0xFFFF;
      }
      this.regs[REG_SOURCE_HI] = src >> 8;
      this.regs[REG_SOURCE_LO] = src & 0xFF;
    } else {
      for (let i = 0; i < count; i++) {
        this.ram[dst & mask] = this.dataByte;
        dst = (dst + 1) & 0xFFFF;
      }
    }
    this.updateAddress = dst;
  }
}
