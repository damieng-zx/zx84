import { describe, it, expect } from 'vitest';
import { narrowMachine } from '@/machines/shared/narrow-machine.ts';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';

describe('narrowMachine', () => {
  const lynx = new LynxMachine('lynx48', null);

  it('returns the same instance when the running kind matches', () => {
    expect(narrowMachine<LynxMachine>(lynx, 'lynx')).toBe(lynx);
  });

  it('returns null when another kind is running', () => {
    expect(narrowMachine<LynxMachine>(lynx, 'msx')).toBeNull();
  });

  it('returns null when no machine is running', () => {
    expect(narrowMachine<LynxMachine>(null, 'lynx')).toBeNull();
  });
});
