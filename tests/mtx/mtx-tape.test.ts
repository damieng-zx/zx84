import { describe, expect, it } from 'vitest';
import { parseMtxTapeHeader } from '@/media/tape/mtx.ts';
import {
  MtxCassette, MTX_TAPE_FAILURE, MTX_TAPE_RETURN, MTX_TAPE_ROUTINE,
} from '@/machines/mtx/mtx-tape.ts';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';

function image(payload: number[] = []): Uint8Array {
  const name = Array.from('TOADO          ', c => c.charCodeAt(0));
  return Uint8Array.from([0xFF, ...name, 0xF2, 0xF8, ...payload]);
}

function machine(): MtxMachine {
  const m = new MtxMachine('mtx512', null);
  m.reset();
  return m;
}

describe('MTX logical cassette image', () => {
  it('decodes the ROM header filename and little-endian stack limit', () => {
    expect(parseMtxTapeHeader(image([1, 2, 3]))).toEqual({
      marker: 0xFF,
      name: 'TOADO',
      stackLimit: 0xF8F2,
    });
    expect(parseMtxTapeHeader(new Uint8Array(17))).toBeNull();
  });

  it('serves requested chunks sequentially and rewinds', () => {
    const cassette = new MtxCassette();
    cassette.mount(image([0x11, 0x22]), 'toado.mtx');

    expect(Array.from(cassette.readChunk(18)!)).toEqual(Array.from(image().subarray(0, 18)));
    expect(Array.from(cassette.readChunk(2)!)).toEqual([0x11, 0x22]);
    expect(cassette.readChunk(1)).toBeNull();

    cassette.rewind();
    expect(cassette.readChunk(1)![0]).toBe(0xFF);
  });

  it('consumes VERIFY chunks and reports both mismatch and short images', () => {
    const cassette = new MtxCassette();
    cassette.mount(Uint8Array.from([1, 2, 3]));

    expect(cassette.verifyChunk(Uint8Array.from([1, 9]))).toBe(false);
    expect(cassette.verifyChunk(Uint8Array.from([3]))).toBe(true);
    expect(cassette.verifyChunk(Uint8Array.from([4]))).toBeNull();
  });
});

describe('MTX ROM cassette trap', () => {
  it('loads the header and following ROM-requested chunk into RAM', () => {
    const m = machine();
    const tape = image([0x21, 0x43, 0x65]);
    m.cassette.mount(tape, 'toado.mtx');
    m.memory.writeByte(0xFD68, 1); // LOAD/VERIFY mode
    m.memory.writeByte(0xFD67, 0); // LOAD

    m.cpu.pc = MTX_TAPE_ROUTINE;
    m.cpu.hl = 0xC011;
    m.cpu.de = 18;
    expect(m.trapCassetteRoutine()).toBe(true);
    expect(m.cpu.pc).toBe(MTX_TAPE_RETURN);
    expect(Array.from(m.memory.readBlock(0xC011, 18))).toEqual(Array.from(tape.subarray(0, 18)));

    m.cpu.pc = MTX_TAPE_ROUTINE;
    m.cpu.hl = 0xD000;
    m.cpu.de = 3;
    expect(m.trapCassetteRoutine()).toBe(true);
    expect(Array.from(m.memory.readBlock(0xD000, 3))).toEqual([0x21, 0x43, 0x65]);
  });

  it('branches to the ROM cleanup path on VERIFY mismatch', () => {
    const m = machine();
    m.cassette.mount(image(), 'toado.mtx');
    m.memory.writeByte(0xFD68, 1);
    m.memory.writeByte(0xFD67, 1); // VERIFY
    m.memory.writeByte(0xC011, 0x00); // differs from the image's FF marker
    m.cpu.pc = MTX_TAPE_ROUTINE;
    m.cpu.hl = 0xC011;
    m.cpu.de = 18;

    expect(m.trapCassetteRoutine()).toBe(true);
    expect(m.cpu.pc).toBe(MTX_TAPE_FAILURE);
  });

  it('leaves SAVE to the physical ROM routine', () => {
    const m = machine();
    m.cassette.mount(image(), 'toado.mtx');
    m.memory.writeByte(0xFD68, 0); // SAVE
    m.cpu.pc = MTX_TAPE_ROUTINE;

    expect(m.trapCassetteRoutine()).toBe(false);
    expect(m.cpu.pc).toBe(MTX_TAPE_ROUTINE);
  });

  it('routes .mtx images through the generic media and tape services', async () => {
    const m = machine();
    const result = await m.services.media.mount(image(), 'toado.mtx');

    expect(result.ok).toBe(true);
    expect(result.target).toBe('cas');
    expect(m.services.tape.loaded).toBe(true);
    expect(m.services.tape.blocks[0]).toMatchObject({
      label: 'MTX "TOADO"',
      kind: 'program',
      size: 18,
    });
  });
});
