/** Shared helpers behind every machine's DiskService.save(). */

import { describe, it, expect } from 'vitest';
import { baseName, saveHfeOr } from '@/machines/shared/disk-save.ts';
import { blankMgtDisk } from '@/media/floppy/mgt-image.ts';
import { attachHfeBitstream, isHFE } from '@/media/floppy/hfe.ts';

describe('baseName', () => {
  it('drops only the last extension', () => {
    expect(baseName('game.tar.dsk')).toBe('game.tar');
    expect(baseName('game.dsk')).toBe('game');
  });

  it('keeps a name that has no extension', () => {
    expect(baseName('game')).toBe('game');
  });

  it("falls back to 'disk' for an empty name", () => {
    expect(baseName('')).toBe('disk');
  });

  it('falls back to the given name for an empty name', () => {
    expect(baseName('', 'plusd')).toBe('plusd');
  });

  it('treats a leading-dot name as having no stem', () => {
    expect(baseName('.dsk', 'x')).toBe('x');
  });
});

describe('saveHfeOr', () => {
  const plain = (): Uint8Array => new Uint8Array([1, 2, 3]);

  it("uses the machine's own format for an image with no bitstream", () => {
    const saved = saveHfeOr(blankMgtDisk(), 'save', '.mgt', plain);
    expect(saved.name).toBe('save.mgt');
    expect(Array.from(saved.data)).toEqual([1, 2, 3]);
  });

  it('writes an HFE for an image that came from a bitstream, ignoring the machine format', () => {
    const image = attachHfeBitstream(blankMgtDisk());
    const saved = saveHfeOr(image, 'save', '.mgt', plain);
    expect(saved.name).toBe('save.hfe');
    expect(isHFE(saved.data)).toBe(true);
  });
});
