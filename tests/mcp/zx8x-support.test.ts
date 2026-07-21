import { describe, expect, it } from 'vitest';
import { MCP_MODELS, isMcpModel } from '../../mcp/models.ts';
import { mountMediaBytes } from '../../mcp/loader.ts';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';

describe('MCP ZX80/ZX81 support', () => {
  it('derives both models from the machine registry', () => {
    expect(MCP_MODELS).toContain('zx80');
    expect(MCP_MODELS).toContain('zx81');
    expect(isMcpModel('zx80')).toBe(true);
    expect(isMcpModel('zx81')).toBe(true);
  });

  it('mounts a ZX80 program through the generic MCP media path', async () => {
    const machine = new Zx8xMachine('zx80', null);
    const result = await mountMediaBytes(machine, new Uint8Array([0x12, 0x34, 0x56]), 'rps.o');

    expect(result).toBe('Program loaded: rps.o');
    expect(machine.memory.readByte(0x4000)).toBe(0x12);
    expect(machine.memory.readByte(0x4002)).toBe(0x56);
  });

  it('keeps program formats constrained to the active ZX model', async () => {
    const machine = new Zx8xMachine('zx80', null);
    const result = await mountMediaBytes(machine, new Uint8Array([0x00]), 'wrong.p');

    expect(result).toContain('ZX80 accepts .o and .80');
  });

  it('exposes ZX81 display-file text through the generic MCP OCR service', async () => {
    const machine = new Zx8xMachine('zx81', null);
    machine.memory.set16kExpansion(true);
    const image = new Uint8Array(0x200);
    image[0x03] = 0x00; // D_FILE at 0x400c -> 0x4200
    image[0x04] = 0x42;
    image.set([0x76, 0x2d, 0x2e, 0x76], 0x1f7); // newline, H, I, newline

    expect(await mountMediaBytes(machine, image, 'hello.p')).toBe('Program loaded: hello.p');
    expect(machine.services.debug.ocr('auto')).toBe('[32x24]\nHI');
  });
});
