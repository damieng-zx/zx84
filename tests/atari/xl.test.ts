/**
 * Atari XL memory architecture tests (600XL / 800XL / 1200XL).
 *
 * Expected behaviour (Atari XL technical notes, and the XL OS's own use of
 * PORTB at $C487 and $C3AF):
 *
 *  - The 16K OS image covers $C000-$CFFF and $D800-$FFFF; its $1000-$17FF
 *    block is the self-test ROM, shown at $5000-$57FF.
 *  - PORTB bit 0 = 1 maps the OS ROM, 0 uncovers RAM (64K machines).
 *    Bit 1 = 0 maps internal BASIC at $A000 (600XL/800XL only).
 *    Bit 7 = 0 maps self-test, but only while the OS ROM is in.
 *  - Port B lines left as inputs float high, so after reset the OS is in,
 *    BASIC and self-test are out.
 *  - ROM wins over the RAM beneath it, writes included; a cartridge wins over
 *    internal BASIC.
 *  - TRIG3 reads 1 while a cartridge is plugged in (the XL OS reads bit 0 at
 *    $C471 to decide whether to run one).
 */

import { describe, it, expect } from 'vitest';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';
import { atariEntry } from '@/machines/atari/descriptor.ts';
import { AtariMemory } from '@/machines/atari/memory.ts';
import { ATARI_XL_OS_SIZE } from '@/machines/atari/models.ts';

/** A 16K XL OS image whose bytes identify their own region. */
function xlOs(): Uint8Array {
  const rom = new Uint8Array(ATARI_XL_OS_SIZE);
  rom.fill(0xc0, 0x0000, 0x1000); // $C000-$CFFF
  rom.fill(0x50, 0x1000, 0x1800); // self-test, shown at $5000
  rom.fill(0xd8, 0x1800, 0x2000); // $D800 floating point
  rom.fill(0xe0, 0x2000, 0x4000); // $E000 OS
  return rom;
}

function xlMemory(ramSize = 0x10000, builtinBasic = true): AtariMemory {
  const mem = new AtariMemory({ ramSize, xl: true, builtinBasic });
  const basic = new Uint8Array(0x2000).fill(0xba);
  expect(mem.loadRom(new Uint8Array([...xlOs(), ...basic]))).toBe(true);
  return mem;
}

describe('atari XL OS ROM and RAM under it', () => {
  it('shows the OS at $C000 and $D800-$FFFF after reset, BASIC and self-test out', () => {
    const mem = xlMemory();
    expect(mem.readByte(0xc000)).toBe(0xc0);
    expect(mem.readByte(0xd800)).toBe(0xd8);
    expect(mem.readByte(0xfffc)).toBe(0xe0);
    mem.ram[0xa000] = 0x11;
    mem.ram[0x5000] = 0x22;
    expect(mem.readByte(0xa000)).toBe(0x11);
    expect(mem.readByte(0x5000)).toBe(0x22);
  });

  it('loses writes under the OS ROM, and uncovers that RAM with PORTB bit 0 = 0', () => {
    const mem = xlMemory();
    mem.writeByte(0xc000, 0x33);
    mem.writeByte(0xe000, 0x44);
    expect(mem.ram[0xc000]).toBe(0);
    mem.setPortB(0xfe);
    expect(mem.readByte(0xc000)).toBe(0x00);
    mem.writeByte(0xc000, 0x33);
    mem.writeByte(0xffff, 0x55);
    expect(mem.readByte(0xc000)).toBe(0x33);
    expect(mem.readByte(0xffff)).toBe(0x55);
    mem.setPortB(0xff);
    expect(mem.readByte(0xffff)).toBe(0xe0); // the ROM is back over it
  });

  it('maps internal BASIC at $A000 with PORTB bit 1 = 0', () => {
    const mem = xlMemory();
    mem.setPortB(0xfd);
    expect(mem.readByte(0xa000)).toBe(0xba);
    expect(mem.readByte(0xbfff)).toBe(0xba);
    expect(mem.readByte(0x9fff)).toBe(0x00); // RAM below
    mem.writeByte(0xa000, 0x77);
    mem.setPortB(0xff);
    expect(mem.readByte(0xa000)).toBe(0x00); // the write never reached RAM
  });

  it('has no BASIC to map on the 1200XL', () => {
    const mem = xlMemory(0x10000, false);
    mem.setPortB(0xfd);
    expect(mem.basicRomEnabled).toBe(false);
    expect(mem.readByte(0xa000)).toBe(0x00);
  });

  it('maps self-test at $5000-$57FF only while the OS ROM is in', () => {
    const mem = xlMemory();
    mem.setPortB(0x7f);
    expect(mem.readByte(0x5000)).toBe(0x50);
    expect(mem.readByte(0x57ff)).toBe(0x50);
    expect(mem.readByte(0x5800)).toBe(0x00);
    mem.setPortB(0x7e); // OS out: self-test cannot be in either
    expect(mem.readByte(0x5000)).toBe(0x00);
  });

  it('lets a cartridge win over internal BASIC', () => {
    const mem = xlMemory();
    mem.setPortB(0xfd);
    mem.insertCart(new Uint8Array(0x2000).fill(0xca));
    expect(mem.readByte(0xa000)).toBe(0xca);
  });

  it('gives the 600XL 16K: open bus above, even with the OS switched out', () => {
    const mem = xlMemory(0x4000);
    expect(mem.readByte(0x4000)).toBe(0xff);
    mem.setPortB(0xfe);
    expect(mem.readByte(0xc000)).toBe(0xff);
  });

  it('shows ANTIC the same banked view as the CPU', () => {
    const mem = xlMemory();
    mem.setPortB(0xfd);
    expect(mem.readRam(0xa000)).toBe(0xba);
    expect(mem.readRam(0xe000)).toBe(0xe0);
    expect(mem.readRam(0xd000)).toBe(0xff); // never the hardware
  });
});

describe('atari XL machine', () => {
  function boot(model: 'atari600xl' | 'atari800xl' | 'atari1200xl' = 'atari800xl'): AtariMachine {
    const m = new AtariMachine(model, null, 'pal');
    const rom = xlOs();
    // Reset vector -> $E000, where the image holds $E0 ($E0 = CPX #imm): a
    // harmless loop of two-byte instructions through the OS area.
    rom[0x3ffc] = 0x00;
    rom[0x3ffd] = 0xe0;
    m.services.roms.installSystemRom(rom);
    m.reset();
    return m;
  }

  it('drives the memory control from PORTB through the PIA', () => {
    const m = boot();
    try {
      m.memory.ram[0xc000] = 0x99;
      m.memory.writeByte(0xd303, 0x30); // PBCTL: select the DDR
      m.memory.writeByte(0xd301, 0xff); // all outputs
      m.memory.writeByte(0xd303, 0x34); // PBCTL: select the port
      m.memory.writeByte(0xd301, 0xfe); // OS out
      expect(m.memory.readByte(0xc000)).toBe(0x99);
      expect(m.memory.readByte(0xd301)).toBe(0xfe);
      m.memory.writeByte(0xd301, 0xff);
      expect(m.memory.readByte(0xc000)).toBe(0xc0);
    } finally {
      m.destroy();
    }
  });

  it('floats PORTB inputs high: making bit 0 an input brings the OS back', () => {
    const m = boot();
    try {
      m.memory.writeByte(0xd303, 0x30);
      m.memory.writeByte(0xd301, 0xff);
      m.memory.writeByte(0xd303, 0x34);
      m.memory.writeByte(0xd301, 0xfe);
      expect(m.memory.osRomEnabled).toBe(false);
      m.memory.writeByte(0xd303, 0x30);
      m.memory.writeByte(0xd301, 0xfe); // bit 0 now an input, pulled high
      expect(m.memory.osRomEnabled).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('senses a cartridge on TRIG3', () => {
    const m = boot('atari1200xl');
    try {
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(0);
      m.services.roms.cartridge!.insert(new Uint8Array(0x2000), 'cart.rom');
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(1);
      m.services.roms.cartridge!.eject();
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('has TRIG3 follow an OSS cartridge switching itself out and back in', () => {
    const m = boot('atari1200xl');
    try {
      const d = new Uint8Array(0x4000);
      d.fill(0x55);
      d[0x0fff] = 0; d[0x1fff] = 3; d[0x2fff] = 4;     // a 034M board
      m.services.roms.cartridge!.insert(d, 'oss.rom');
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(1);
      m.memory.readByte(0xd508);                        // off: the window is open
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(0);
      m.memory.readByte(0xd500);                        // and back
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(1);
      m.memory.writeByte(0xd50c, 0);                    // a write switches it too
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('keeps TRIG3 a joystick trigger on the 800', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.services.roms.cartridge!.insert(new Uint8Array(0x2000), 'cart.rom');
      expect(m.gtia.readReg(0xd013) & 0x01).toBe(1); // released
    } finally {
      m.destroy();
    }
  });

  it('fits 16K on the 600XL and 64K on the 800XL and 1200XL', () => {
    for (const [model, size] of [['atari600xl', 0x4000], ['atari800xl', 0x10000], ['atari1200xl', 0x10000]] as const) {
      const m = boot(model);
      try {
        expect(m.ramSize).toBe(size);
      } finally {
        m.destroy();
      }
    }
  });

  it('exposes the XL ROM blocks as memory regions', () => {
    const m = boot();
    try {
      expect(m.resolveMemoryRegion('rom-os')).toMatchObject({ baseAddr: 0xe000 });
      expect(m.resolveMemoryRegion('rom-os')!.data[0]).toBe(0xe0);
      expect(m.resolveMemoryRegion('rom-fp')!.data[0]).toBe(0xd8);
      expect(m.resolveMemoryRegion('rom-os-c000')!.data[0]).toBe(0xc0);
      expect(m.resolveMemoryRegion('rom-self-test')).toMatchObject({ baseAddr: 0x5000 });
      expect(m.resolveMemoryRegion('rom-basic')!.data.length).toBe(0x2000);
    } finally {
      m.destroy();
    }
  });
});

describe('atari XL registry entries', () => {
  it('builds the system image from AltirraOS XL, plus Altirra BASIC where BASIC is built in', () => {
    expect(atariEntry.romSources('atari600xl')).toEqual(['atari/altirraos-xl.rom', 'atari/altirra-basic.rom']);
    expect(atariEntry.romSources('atari800xl')).toEqual(['atari/altirraos-xl.rom', 'atari/altirra-basic.rom']);
    expect(atariEntry.romSources('atari1200xl')).toEqual(['atari/altirraos-xl.rom']);
  });

  it('hidden-mounts the BASIC cartridge only where BASIC is not built in', () => {
    expect(atariEntry.bootCartridgeSource?.('atari800xl')).toBeUndefined();
    expect(atariEntry.bootCartridgeSource?.('atari1200xl')).toBe('atari/altirra-basic.rom');
    expect(atariEntry.descriptor('atari800xl').ui.bootCartridge).toBe(false);
    expect(atariEntry.descriptor('atari1200xl').ui.bootCartridge).toBe(true);
  });

  it('classifies a dropped 16K image as an XL OS', () => {
    expect(atariEntry.detectModelForRom?.(new Uint8Array(0x4000), 'atari800')).toBe('atari800xl');
    expect(atariEntry.detectModelForRom?.(new Uint8Array(0x4000), 'atari1200xl')).toBe('atari1200xl');
    expect(atariEntry.detectModelForRom?.(new Uint8Array(0x2800), 'atari600xl')).toBe('atari800');
  });
});

describe('atari 130XE extended RAM', () => {
  function xeMemory(): AtariMemory {
    const mem = new AtariMemory({ ramSize: 0x10000, xl: true, builtinBasic: true, extBanks: 4 });
    expect(mem.loadRom(new Uint8Array([...xlOs(), ...new Uint8Array(0x2000).fill(0xba)]))).toBe(true);
    return mem;
  }
  /** PORTB with the OS in, BASIC out, self-test out, and these banking bits. */
  const portb = (bank: number, cpu: boolean, antic: boolean) =>
    0xc3 | (bank << 2) | (cpu ? 0 : 0x10) | (antic ? 0 : 0x20);

  it('leaves $4000-$7FFF as main RAM after reset', () => {
    const mem = xeMemory();
    mem.writeByte(0x4000, 0x12);
    expect(mem.ram[0x4000]).toBe(0x12);
    expect(mem.extRam.every(b => b === 0)).toBe(true);
    expect(mem.totalRamSize).toBe(0x20000);
  });

  it('gives the CPU four independent 16K banks with PORTB bits 2-3 and 4', () => {
    const mem = xeMemory();
    for (let bank = 0; bank < 4; bank++) {
      mem.setPortB(portb(bank, true, false));
      mem.writeByte(0x4000, 0x10 + bank);
      mem.writeByte(0x7fff, 0x20 + bank);
    }
    for (let bank = 0; bank < 4; bank++) {
      mem.setPortB(portb(bank, true, false));
      expect(mem.readByte(0x4000)).toBe(0x10 + bank);
      expect(mem.readByte(0x7fff)).toBe(0x20 + bank);
    }
    mem.setPortB(0xff);
    expect(mem.readByte(0x4000)).toBe(0x00); // main RAM was never touched
    expect(mem.readByte(0x3fff)).toBe(0x00);
    expect(mem.readByte(0x8000)).toBe(0x00);
  });

  it('lets the CPU and ANTIC see different blocks', () => {
    const mem = xeMemory();
    mem.ram[0x4000] = 0xaa;
    mem.setPortB(portb(2, true, false)); // CPU in bank 2, ANTIC on main RAM
    mem.writeByte(0x4000, 0xbb);
    expect(mem.readByte(0x4000)).toBe(0xbb);
    expect(mem.readRam(0x4000)).toBe(0xaa);
    mem.setPortB(portb(2, false, true)); // ANTIC in bank 2, CPU on main RAM
    expect(mem.readByte(0x4000)).toBe(0xaa);
    expect(mem.readRam(0x4000)).toBe(0xbb);
    mem.setPortB(portb(2, true, true));
    expect(mem.readRam(0x4000)).toBe(0xbb);
    expect(mem.snapshot()[0x4000]).toBe(0xbb); // the snapshot is the CPU's view
  });

  it('keeps self-test ROM over the window', () => {
    const mem = xeMemory();
    mem.setPortB(portb(1, true, true) & 0x7f);
    expect(mem.readByte(0x5000)).toBe(0x50);
    expect(mem.readByte(0x4fff)).toBe(0x00);
  });

  it('addresses the extended banks as RAM banks after the main ones', () => {
    const mem = xeMemory();
    expect(mem.ramBankCount).toBe(8);
    mem.setPortB(portb(3, true, false));
    mem.writeByte(0x6000, 0x99);
    expect(mem.getRamBank(7)[0x2000]).toBe(0x99);
    expect(mem.getRamBank(1)[0x2000]).toBe(0x00);
  });

  it('ignores the banking bits on a 64K machine', () => {
    const mem = new AtariMemory({ ramSize: 0x10000, xl: true, builtinBasic: true });
    mem.setPortB(portb(1, true, true));
    mem.writeByte(0x4000, 0x42);
    expect(mem.ram[0x4000]).toBe(0x42);
    expect(mem.totalRamSize).toBe(0x10000);
  });
});

describe('atari XE models', () => {
  it('fit 64K on the 65XE and 800XE and 128K on the 130XE', () => {
    for (const [model, size] of [['atari65xe', 0x10000], ['atari800xe', 0x10000], ['atari130xe', 0x20000]] as const) {
      const m = new AtariMachine(model, null, 'pal');
      try {
        expect(m.ramSize).toBe(size);
        expect(m.memory.xl).toBe(true);
        expect(m.memory.basicRom).not.toBeNull();
      } finally {
        m.destroy();
      }
    }
  });

  it('banks the 130XE through PORTB written via the PIA', () => {
    const m = new AtariMachine('atari130xe', null, 'pal');
    try {
      m.services.roms.installSystemRom(xlOs());
      m.reset();
      m.memory.writeByte(0xd303, 0x00); // select the data direction register
      m.memory.writeByte(0xd301, 0xff); // all outputs
      m.memory.writeByte(0xd303, 0x04); // back to the data register
      m.memory.writeByte(0xd301, 0xc3 | (1 << 2) | 0x20); // CPU in bank 1
      m.memory.writeByte(0x4800, 0x5a);
      m.memory.writeByte(0xd301, 0xff);
      expect(m.memory.readByte(0x4800)).toBe(0x00);
      m.memory.writeByte(0xd301, 0xc3 | (1 << 2) | 0x20);
      expect(m.memory.readByte(0x4800)).toBe(0x5a);
      expect(m.ramExportBytes().data.length).toBe(0x20000);
      expect(m.ramExportBytes().filename).toBe('atari130xe-ram-128k.bin');
    } finally {
      m.destroy();
    }
  });

  it('treats an XL OS image dropped on an XE as theirs', () => {
    expect(atariEntry.detectModelForRom?.(new Uint8Array(0x4000), 'atari130xe')).toBe('atari130xe');
    expect(atariEntry.romSources('atari130xe')).toEqual(['atari/altirraos-xl.rom', 'atari/altirra-basic.rom']);
    expect(atariEntry.descriptor('atari65xe').ui.bootCartridge).toBe(false);
  });
});
