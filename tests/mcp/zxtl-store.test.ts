import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearZxtlBuffer,
  setZxtlBuffer,
  zxtlBufferSize,
  readZxtlChunk,
} from '../../mcp/zxtl-store.ts';

describe('zxtl-store', () => {
  beforeEach(() => clearZxtlBuffer());

  it('starts empty', () => {
    expect(zxtlBufferSize()).toBe(0);
    const c = readZxtlChunk(0);
    expect(c).toEqual({ total: 0, start: 0, end: 0, lines: [] });
  });

  it('stores a snapshot of the input (copy, not reference)', () => {
    const src = ['a', 'b', 'c'];
    setZxtlBuffer(src);
    src.push('d');
    expect(zxtlBufferSize()).toBe(3);
    expect(readZxtlChunk(0, 99).lines).toEqual(['a', 'b', 'c']);
  });

  it('defaults to a 100-line chunk when `to` is omitted', () => {
    const lines = Array.from({ length: 250 }, (_, i) => `L${i}`);
    setZxtlBuffer(lines);
    const c = readZxtlChunk(0);
    expect(c.total).toBe(250);
    expect(c.start).toBe(0);
    expect(c.end).toBe(100);
    expect(c.lines).toHaveLength(100);
    expect(c.lines[0]).toBe('L0');
    expect(c.lines[99]).toBe('L99');
  });

  it('clamps `to` past end of buffer', () => {
    setZxtlBuffer(['x', 'y', 'z']);
    const c = readZxtlChunk(1, 999);
    expect(c).toEqual({ total: 3, start: 1, end: 3, lines: ['y', 'z'] });
  });

  it('clamps `from` past end of buffer to total', () => {
    setZxtlBuffer(['x', 'y', 'z']);
    const c = readZxtlChunk(99, 200);
    expect(c.total).toBe(3);
    expect(c.start).toBe(3);
    expect(c.end).toBe(3);
    expect(c.lines).toEqual([]);
  });

  it('clamps negative `from` to 0', () => {
    setZxtlBuffer(['x', 'y', 'z']);
    const c = readZxtlChunk(-5, 2);
    expect(c.start).toBe(0);
    expect(c.end).toBe(2);
    expect(c.lines).toEqual(['x', 'y']);
  });

  it('returns an empty slice when `to` <= `from`', () => {
    setZxtlBuffer(['x', 'y', 'z']);
    const c = readZxtlChunk(2, 1);
    expect(c.start).toBe(2);
    expect(c.end).toBe(2);
    expect(c.lines).toEqual([]);
  });

  it('returns an empty slice when `from` equals total', () => {
    setZxtlBuffer(['x', 'y', 'z']);
    const c = readZxtlChunk(3);
    expect(c.start).toBe(3);
    expect(c.end).toBe(3);
    expect(c.lines).toEqual([]);
  });

  it('clearZxtlBuffer empties the store', () => {
    setZxtlBuffer(['a', 'b']);
    expect(zxtlBufferSize()).toBe(2);
    clearZxtlBuffer();
    expect(zxtlBufferSize()).toBe(0);
    expect(readZxtlChunk(0).lines).toEqual([]);
  });
});
