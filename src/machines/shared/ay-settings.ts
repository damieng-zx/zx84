/**
 * Shared AY/PSG settings application. Every machine carries an AY-family PSG
 * and reads the same three persisted knobs from its SettingsView — one helper
 * so the four applySettings implementations can't drift.
 */

import type { AY3891x, AYStereoMode, AYAntialiasMode } from '@/cores/ay-3-8910.ts';
import type { SettingsView } from '@/machines/machine.ts';

export function applyAySettings(ay: AY3891x, view: SettingsView): void {
  ay.setStereoMode(view.get<AYStereoMode>('ay-stereo', 'ABC'));
  ay.dcBlocking = view.get('ay-dc-block', true);
  ay.antialias = view.get<AYAntialiasMode>('ay-antialias', 'mute');
}
