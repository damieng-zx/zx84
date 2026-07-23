import { describe, expect, it, vi } from 'vitest';
import { entryForModel } from '@/machines/registry.ts';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';

describe('ZX80/ZX81 machine family', () => {
  it('registers both models with their native ROM sizes and software library', () => {
    const zx80 = entryForModel('zx80');
    const zx81 = entryForModel('zx81');
    expect(zx80.kind).toBe('zx8x');
    expect(zx81).toBe(zx80);
    expect(zx80.romSources('zx80')).toEqual([
      'sinclair/zx80.rom',
    ]);
    expect(zx80.romSources('zx81')).toEqual([
      'sinclair/zx81-v2.rom',
    ]);
    expect(zx81.descriptor('zx81').ui.library).toBe(true);
  });

  it('routes only native program-image extensions', () => {
    const zx80 = new Zx8xMachine('zx80');
    const zx81 = new Zx8xMachine('zx81');
    expect(zx80.services.media.accepts().map(value => value.ext)).toEqual(['.o', '.80']);
    expect(zx81.services.media.accepts().map(value => value.ext)).toEqual(['.p', '.81', '.p81']);
  });

  it('requires 16KB RAM for a program larger than internal RAM', async () => {
    const machine = new Zx8xMachine('zx81');
    const load = vi.spyOn(machine, 'loadProgram').mockImplementation(() => {});
    const tooLarge = await machine.services.media.mount(new Uint8Array(0x500), 'large.p');
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.message).toContain('needs 16KB RAM');
    expect(load).not.toHaveBeenCalled();

    machine.memory.set16kExpansion(true);
    const loaded = await machine.services.media.mount(new Uint8Array([1, 2, 3]), 'game.p');
    expect(loaded.ok).toBe(true);
    expect(load).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), 0x4009);
  });

  it('applies the shared 16KB RAM setting', () => {
    const machine = new Zx8xMachine('zx80');
    machine.applySettings({ get: (_key, fallback) => (true as typeof fallback) });
    expect(machine.memory.has16kExpansion).toBe(true);
    expect(machine.memory.ramSize).toBe(0x4000);
  });

  it('restores the ZX81 post-LOAD state without selecting IM 2', () => {
    const machine = new Zx8xMachine('zx81');
    machine.memory.set16kExpansion(true);

    machine.loadProgram(new Uint8Array([0x00]), 0x4009);

    expect(machine.cpu.pc).toBe(0x0207);
    expect(machine.cpu.sp).toBe(0x7ffc);
    expect(machine.cpu.im).toBe(1);
    expect(Array.from(machine.memory.snapshot().slice(0x4000, 0x4009))).toEqual([
      0xff, 0x80, 0xfc, 0x7f, 0x00, 0x80, 0x00, 0xfe, 0xff,
    ]);
    expect(Array.from(machine.memory.snapshot().slice(0x7ffc, 0x8000))).toEqual([
      0x76, 0x06, 0x00, 0x3e,
    ]);
  });
});
