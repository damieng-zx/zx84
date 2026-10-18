import { describe, it, expect } from 'vitest';
import type { SettingsView } from '@/machines/machine.ts';
import { resolveDriveCount } from '@/machines/shared/drive-count.ts';

const view = (values: Record<string, unknown>): SettingsView => ({
  get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; },
});

describe('resolveDriveCount', () => {
  it('fits every drive when no count was chosen', () => {
    expect(resolveDriveCount(view({}), 'lynx', 4)).toBe(4);
  });

  it('reads the count saved for the machine kind', () => {
    expect(resolveDriveCount(view({ 'drive-count:lynx': 3 }), 'lynx', 4)).toBe(3);
    expect(resolveDriveCount(view({ 'drive-count:lynx': 3 }), 'cpc', 2)).toBe(2);
  });

  it('holds the count between one drive and what the model can take', () => {
    expect(resolveDriveCount(view({ 'drive-count:cpc': 4 }), 'cpc', 2)).toBe(2);
    expect(resolveDriveCount(view({ 'drive-count:cpc': 0 }), 'cpc', 2)).toBe(1);
    expect(resolveDriveCount(view({ 'drive-count:cpc': Number.NaN }), 'cpc', 2)).toBe(2);
  });
});
