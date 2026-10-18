import type { SettingsView } from '@/machines/machine.ts';

/** How many of a machine's built-in floppy drives are fitted: the count the user
 *  chose from the first drive's menu, held to what the model can take. With no
 *  choice saved, every drive is fitted. */
export function resolveDriveCount(view: SettingsView, kind: string, max: number): number {
  const n = Math.trunc(view.get<number>(`drive-count:${kind}`, max));
  return Math.min(max, Math.max(1, Number.isFinite(n) ? n : max));
}
