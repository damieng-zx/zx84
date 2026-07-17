/**
 * MsxCassette — .cas block navigation.
 *
 * The .cas format places an 8-byte header ID (1F A6 DE BA CC 13 7D 74) on an
 * 8-byte boundary before each block. TAPION advances past the next ID; TAPIN
 * reads the following bytes. Expectations are built from the format spec.
 */
import { describe, it, expect } from 'vitest';
import { MsxCassette, parseCasBlocks } from '@/machines/msx/msx-tape.ts';

const ID = [0x1F, 0xA6, 0xDE, 0xBA, 0xCC, 0x13, 0x7D, 0x74];

/** Build a .cas: ID + block1 (padded to 8) + ID + block2. */
function makeCas(block1: number[], block2: number[]): Uint8Array {
  const pad = (b: number[]) => { const n = (b.length + 7) & ~7; return [...b, ...new Array(n - b.length).fill(0)]; };
  return Uint8Array.from([...ID, ...pad(block1), ...ID, ...block2]);
}

describe('MsxCassette', () => {
  it('finds the first header and reads the block bytes in order', () => {
    const cas = new MsxCassette();
    cas.mount(makeCas([0x41, 0x42], [0x43, 0x44]));  // "AB", "CD"
    expect(cas.loaded).toBe(true);
    expect(cas.findHeader()).toBe(true);              // skip ID #1
    expect(cas.readByte()).toBe(0x41);
    expect(cas.readByte()).toBe(0x42);
  });

  it('advances to the second header from mid-stream (8-byte aligned)', () => {
    const cas = new MsxCassette();
    cas.mount(makeCas([0x41, 0x42], [0x43, 0x44]));
    cas.findHeader();                 // past ID #1 → pos 8
    cas.readByte(); cas.readByte();   // read "AB" → pos 10
    expect(cas.findHeader()).toBe(true);   // ID #2 is at aligned offset 16
    expect(cas.readByte()).toBe(0x43);
    expect(cas.readByte()).toBe(0x44);
  });

  it('reports EOF from readByte and failure from findHeader at the end', () => {
    const cas = new MsxCassette();
    cas.mount(Uint8Array.from([...ID, 0x99]));   // one block, one byte
    expect(cas.findHeader()).toBe(true);
    expect(cas.readByte()).toBe(0x99);
    expect(cas.readByte()).toBe(-1);             // past end
    expect(cas.findHeader()).toBe(false);        // no further header
  });

  it('does not recognise a header at a non-8-aligned offset', () => {
    const cas = new MsxCassette();
    // ID shifted by 1 byte → not on an 8-boundary → not a header.
    cas.mount(Uint8Array.from([0x00, ...ID, 0x99]));
    expect(cas.findHeader()).toBe(false);
  });

  it('getData returns the mounted image, and it re-mounts intact (stash round-trip)', () => {
    const img = Uint8Array.from([...ID, 0x10, 0x20, 0x30]);
    const cas = new MsxCassette();
    cas.mount(img, 'game.cas');
    const stashed = cas.getData();
    expect(Array.from(stashed)).toEqual(Array.from(img));
    // Re-mount the stashed bytes into a fresh cassette (as a platform switch would).
    const restored = new MsxCassette();
    restored.mount(stashed, 'game.cas');
    expect(restored.findHeader()).toBe(true);
    expect(restored.readByte()).toBe(0x10);
  });

  it('parseCasBlocks lists a file header (name + type) and its data block', () => {
    const name = [0x47, 0x41, 0x4D, 0x45, 0x20, 0x20];   // "GAME  "
    const header = [...new Array(10).fill(0xD3), ...name]; // 16 bytes → BASIC header
    const cas = Uint8Array.from([...ID, ...header, ...ID, 0x01, 0x02, 0x03, 0x04, 0x05]);
    const blocks = parseCasBlocks(cas);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ header: true, title: 'Header "GAME"', detail: 'BASIC file', name: 'GAME', type: 'BASIC', size: 16 });
    expect(blocks[1]).toEqual({ header: false, title: 'Data', detail: '5 bytes', size: 5 });
  });

  it('parseCasBlocks classifies binary/ASCII header markers', () => {
    const mk = (marker: number) => Uint8Array.from([...ID, ...new Array(10).fill(marker), 0x41, 0x42, 0x43, 0x44, 0x45, 0x46]);
    expect(parseCasBlocks(mk(0xD0))[0].detail).toBe('Binary file');
    expect(parseCasBlocks(mk(0xEA))[0].detail).toBe('ASCII file');
  });

  it('currentBlock tracks the read position across blocks', () => {
    // Two blocks: a 16-byte header (→ 8-aligned) then a data block.
    const header = new Array(16).fill(0xD3);
    const cas = new MsxCassette();
    cas.mount(Uint8Array.from([...ID, ...header, ...ID, 0x01, 0x02, 0x03]));
    cas.findHeader();                       // consume ID #1 → reading block 0
    expect(cas.currentBlock()).toBe(0);
    for (let i = 0; i < 16; i++) cas.readByte(); // read the whole header block
    expect(cas.currentBlock()).toBe(1);     // now at ID #2 → block 1
    cas.findHeader();
    expect(cas.currentBlock()).toBe(1);
  });

  it('eject clears the loaded state', () => {
    const cas = new MsxCassette();
    cas.mount(Uint8Array.from([...ID, 0x01]));
    cas.eject();
    expect(cas.loaded).toBe(false);
    expect(cas.readByte()).toBe(-1);
  });
});
