import { describe, expect, it } from 'vitest';
import { parseUrlModel } from '@/state/machine-state.ts';

describe('startup URL model parameter', () => {
  it('resolves known models case-insensitively', () => {
    expect(parseUrlModel('?model=cpc6128')).toBe('cpc6128');
    expect(parseUrlModel('?model=BBC-B')).toBe('bbc-b');
    expect(parseUrlModel('?machine=48K')).toBe('48k');
  });

  it('accepts the + models encoded, unencoded, or spelled plus', () => {
    expect(parseUrlModel('?model=%2B3')).toBe('+3');
    expect(parseUrlModel('?model=+2a')).toBe('+2A');
    expect(parseUrlModel('?model=plus2a')).toBe('+2A');
  });

  it('ignores missing and unknown values', () => {
    expect(parseUrlModel('')).toBeNull();
    expect(parseUrlModel('?model=')).toBeNull();
    expect(parseUrlModel('?model=c64')).toBeNull();
  });
});
