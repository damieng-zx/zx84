import { describe, expect, it, vi } from 'vitest';
import { entryForModel } from '@/machines/registry.ts';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';

function machine(model: 'mtx500' | 'mtx512' | 'rs128' = 'mtx512'): MtxMachine {
  const m = new MtxMachine(model, null);
  m.turbo = true;
  m.reset();
  return m;
}

describe('MTX machine registration', () => {
  it('constructs every MTX model through the headless machine registry', () => {
    expect(entryForModel('rs128').models).toEqual(['mtx500', 'mtx512', 'rs128']);
    for (const model of ['mtx500', 'mtx512', 'rs128'] as const) {
      const entry = entryForModel(model);
      const m = entry.create(model, null);
      expect(entry.kind).toBe('mtx');
      expect(m.kind).toBe('mtx');
      expect(m.model).toBe(model);
    }
  });

  it('exports the RS128 base RAM under its own model identity', () => {
    const m = machine('rs128');

    expect(m.memory.ramSizeBytes).toBe(128 * 1024);
    expect(m.ramExportBytes()).toMatchObject({
      filename: 'rs128-ram-128k.bin',
      data: { length: 128 * 1024 },
    });
  });

  it('exposes both fixed-wiring joystick ports through the input service', () => {
    const m = machine();
    expect(m.descriptor.ui.joystick).toBe(true);
    expect(m.descriptor.ui.fixedJoystick).toBe(true);

    m.services.input.joystick.press('up', true, 'fixed', 0);
    m.keyboard.selectDrive(0xFB);
    expect(m.keyboard.readSenseLow()).toBe(0x7F);

    m.services.input.releaseAll();
    m.keyboard.selectDrive(0xFB);
    expect(m.keyboard.readSenseLow()).toBe(0xFF);
  });

  it('declares the page-4 CP/M bootstrap before page-5 Disk BASIC', () => {
    const entry = entryForModel('mtx512');

    expect(entry.romSources('mtx512')).toEqual([
      'memotech/os.rom',
      'memotech/basic.rom',
      'memotech/assem.rom',
      'memotech/boot-type07.rom',
      'memotech/sdx-type07.rom',
    ]);
    expect(entry.detectModelForRom?.(new Uint8Array(0xA000), 'mtx512')).toBe('mtx512');
  });

  it('loads and ejects a native ROM pack through the cartridge service', async () => {
    const m = machine();
    const pack = new Uint8Array(0x4000);
    pack[0] = 0x21;
    pack[0x2000] = 0x22;

    const result = await m.services.media.mount(pack, 'pascal.rom');

    expect(m.descriptor.ui.cartridge).toBe(true);
    expect(m.services.media.accepts()).toContainEqual({ ext: '.rom', target: 'cartridge' });
    expect(result).toEqual({
      ok: true,
      target: 'cartridge',
      message: 'ROM pack: pascal.rom — type ROM 2',
    });
    expect(m.services.roms.cartridge.name).toBe('pascal.rom');
    m.memory.setPageRegister(0x20);
    expect(m.memory.readByte(0x2000)).toBe(0x21);
    m.memory.writeByte(0, 1);
    expect(m.memory.readByte(0x2000)).toBe(0x22);

    m.services.roms.cartridge.eject();
    expect(m.services.roms.cartridge.name).toBe('');
    m.memory.setPageRegister(0x20);
    expect(m.memory.readByte(0x2000)).toBe(0xFF);
  });

  it('reports invalid ROM-pack geometry through media routing', async () => {
    const m = machine();

    const result = await m.services.media.mount(new Uint8Array(123), 'broken.rom');

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/1-16 complete 8 KiB banks/);
  });
});

describe('MTX motherboard I/O', () => {
  it('routes the IOBYTE paging latch through port 0', () => {
    const m = machine();

    m.cpu.portOut(0xAB00, 0x92);

    expect(m.memory.pageRegister).toBe(0x92);
    expect(m.memory.selectedRamPage).toBe(2);
    expect(m.memory.selectedRomPage).toBe(1);
    expect(m.memory.ramMode).toBe(true);
  });

  it('routes TMS9929A register and VRAM writes through ports 2 and 1', () => {
    const m = machine();

    m.cpu.portOut(0x02, 0x50);
    m.cpu.portOut(0x02, 0x81);
    expect(m.vdp.regs[1]).toBe(0x50);

    m.cpu.portOut(0x02, 0x00);
    m.cpu.portOut(0x02, 0x40);
    m.cpu.portOut(0x01, 0x99);
    expect(m.vdp.vram[0]).toBe(0x99);
  });

  it('scans the active-low keyboard matrix through ports 5 and 6', () => {
    const m = machine();
    m.keyboard.handleKeyEvent('KeyA', true);

    m.cpu.portOut(0x05, 0xDF);

    expect(m.cpu.portIn(0x05)).toBe(0xFE);
    expect(m.cpu.portIn(0x06)).toBe(0x03);
  });

  it('latches PSG data on OUT (6) and writes it to the chip on a read of port 3', () => {
    // MAME mtx.cpp: port 6 write = sound_lach_w, port 3 read = sound_strobe_r.
    const m = machine();

    m.cpu.portOut(0x06, 0x85);
    m.cpu.portOut(0x06, 0x2A);                 // overwrites the latch: 0x85 is lost
    expect(m.activity.psgWrites).toBe(0);
    expect(m.psg.tonePeriod[0]).toBe(0);

    m.cpu.portOut(0x06, 0x85);
    expect(m.cpu.portIn(0x03)).toBe(0x03);     // strobe: latch/tone 0, low nibble 5
    m.cpu.portOut(0x06, 0x2A);
    m.cpu.portIn(0x03);                        // data byte: high six bits 0x2A

    expect(m.psg.tonePeriod[0]).toBe(0x2A5);
    expect(m.activity.psgWrites).toBe(2);
  });
});

describe('MTX CPU boot wiring', () => {
  it('executes firmware from the fixed OS ROM and reaches the VDP', () => {
    const m = machine();
    const firmware = new Uint8Array(0x6000);
    firmware.set([
      0x3E, 0xD0,       // LD A,D0
      0xD3, 0x02,       // OUT (02),A
      0x3E, 0x81,       // LD A,81
      0xD3, 0x02,       // OUT (02),A: VDP R1 := D0
      0x76,             // HALT
    ]);
    m.loadROM(firmware);
    m.reset();

    for (let i = 0; i < 5; i++) m.cpu.step();

    expect(m.cpu.halted).toBe(true);
    expect(m.vdp.regs[1]).toBe(0xD0);
  });
});

describe('MTX MCP screen OCR', () => {
  it('reads ASCII text directly from the TMS9929A text-mode name table', () => {
    const m = machine();
    m.vdp.regs[1] = 0x10; // M1: 40-column text mode
    m.vdp.regs[2] = 0x07; // name table at 0x1C00, as used by the MTX ROM
    const nameBase = 0x1C00;
    m.vdp.vram.fill(0x20, nameBase, nameBase + 40 * 24);
    const text = ' Ready';
    for (let i = 0; i < text.length; i++) {
      m.vdp.vram[nameBase + 23 * 40 + i] = text.charCodeAt(i);
    }

    const rows = m.ocrScreenForMcp().split('\n');

    expect(rows).toHaveLength(24);
    expect(rows[23]).toBe(' Ready');
  });
});

describe('MTX VDP interrupt into CTC channel 0', () => {
  // The TMS9929A's /INT is a level (F AND IE) on CTC channel 0's CLK/TRG. The
  // CTC counts edges, so a flag nobody clears cannot count twice.
  function withVdpIe(m: MtxMachine): void {
    m.cpu.portOut(0x02, 0x20);   // R1 = IE
    m.cpu.portOut(0x02, 0x81);
  }

  it('triggers once per assertion, not once per frame while F stays set', () => {
    const m = machine();
    withVdpIe(m);
    const trigger = vi.spyOn(m.ctc, 'trigger');
    m.tick(); m.tick(); m.tick();                  // nothing reads the status
    expect(trigger.mock.calls.filter(([c]) => c === 0)).toHaveLength(1);
  });

  it('triggers again each frame once the status read clears F', () => {
    const m = machine();
    withVdpIe(m);
    const trigger = vi.spyOn(m.ctc, 'trigger');
    for (let i = 0; i < 3; i++) { m.tick(); m.cpu.portIn(0x02); }
    expect(trigger.mock.calls.filter(([c]) => c === 0)).toHaveLength(3);
  });

  it('makes an edge when IE is set while F is already pending', () => {
    const m = machine();                            // IE clear: F sets silently
    const trigger = vi.spyOn(m.ctc, 'trigger');
    m.tick();
    expect(trigger).not.toHaveBeenCalled();
    withVdpIe(m);
    expect(trigger.mock.calls.filter(([c]) => c === 0)).toHaveLength(1);
  });
});

describe('MTX CTC RETI wiring', () => {
  it('a RETI executed by the CPU ends the CTC channel under service', () => {
    const m = machine();
    m.ctc.write(0, 0x01 | 0x40 | 0x80 | 0x04);  // ch0: counter, int, TC follows
    m.ctc.write(0, 1);
    m.ctc.trigger(0);
    m.ctc.acknowledge();
    expect(m.ctc.ieo).toBe(false);
    m.cpu.sp = 0xC000;
    m.cpu.pc = 0xC100;
    m.memory.writeByte(0xC100, 0xED);
    m.memory.writeByte(0xC101, 0x4D);             // RETI
    m.cpu.step();
    expect(m.ctc.ieo).toBe(true);
  });
});
