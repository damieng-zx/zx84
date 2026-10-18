import { describe, expect, it } from 'vitest';
import { parseUrlModel } from '@/state/machine-state.ts';

describe('startup URL model parameter', () => {
  it('resolves known models case-insensitively', () => {
    expect(parseUrlModel('?model=cpc6128')).toBe('cpc6128');
    expect(parseUrlModel('?model=BBC-B')).toBe('bbc-b');
    expect(parseUrlModel('?model=Electron')).toBe('electron');
    expect(parseUrlModel('?machine=ZX48K')).toBe('zx48k');
  });

  it('resolves every Spectrum id as written, with no + to encode', () => {
    expect(parseUrlModel('?model=zx16k')).toBe('zx16k');
    expect(parseUrlModel('?model=zx128k')).toBe('zx128k');
    expect(parseUrlModel('?model=zx128kplus2')).toBe('zx128kplus2');
    expect(parseUrlModel('?model=zx128kplus2a')).toBe('zx128kplus2a');
    expect(parseUrlModel('?model=zx128kplus3')).toBe('zx128kplus3');
  });

  it('still resolves the Spectrum ids that existing links use', () => {
    expect(parseUrlModel('?machine=48K')).toBe('zx48k');
    expect(parseUrlModel('?model=16k')).toBe('zx16k');
    expect(parseUrlModel('?model=128k')).toBe('zx128k');
    expect(parseUrlModel('?model=%2B3')).toBe('zx128kplus3');
    expect(parseUrlModel('?model=+2a')).toBe('zx128kplus2a');
    expect(parseUrlModel('?model=plus2a')).toBe('zx128kplus2a');
    expect(parseUrlModel('?model=plus2')).toBe('zx128kplus2');
  });

  it('ignores missing and unknown values', () => {
    expect(parseUrlModel('')).toBeNull();
    expect(parseUrlModel('?model=')).toBeNull();
    expect(parseUrlModel('?model=c64')).toBeNull();
  });
});
