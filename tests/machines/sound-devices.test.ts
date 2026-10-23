/**
 * Per-device sound volumes. A machine declares every hardware sound device it can
 * have in `ui.soundDevices`; the Sound pane draws one slider per fitted device
 * (once there are two or more) and the machine reads the same list to set its
 * mixer. These tests pin the declaration helpers, what each machine declares, and
 * that the machines apply the volumes — not the pane markup itself.
 */

import { describe, it, expect } from 'vitest';
import {
  presentSoundDevices, soundDeviceGains, soundDeviceMaxVolume,
  type SettingsView, type SoundDeviceInfo,
} from '@/machines/machine.ts';
import { registry } from '@/machines/registry.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { spectrumDescriptor } from '@/machines/spectrum/descriptor.ts';
import { apple2Descriptor } from '@/machines/apple2/descriptor.ts';
import { atariDescriptor } from '@/machines/atari/descriptor.ts';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import type { SpectrumModel } from '@/models.ts';

function view(values: Record<string, unknown>): SettingsView {
  return { get<T>(key: string, fallback: T): T { return (key in values ? values[key] : fallback) as T; } };
}
const on = (...keys: string[]) => (k: string) => keys.includes(k);
const ids = (d: readonly SoundDeviceInfo[]) => d.map((x) => x.id);

const BEEPER: SoundDeviceInfo = { id: 'beeper', label: 'Beeper', volumeSetting: 'beeper-volume' };
const PSG: SoundDeviceInfo = { id: 'psg', label: 'AY', volumeSetting: 'psg-volume' };
const DAC: SoundDeviceInfo = { id: 'dac', label: 'DAC', volumeSetting: 'dac-volume', enabledSetting: 'dac', maxVolume: 200 };

describe('presentSoundDevices', () => {
  it('keeps devices with no enabledSetting and those whose setting is on', () => {
    expect(ids(presentSoundDevices([BEEPER, PSG, DAC], on('dac')))).toEqual(['beeper', 'psg', 'dac']);
    expect(ids(presentSoundDevices([BEEPER, PSG, DAC], on()))).toEqual(['beeper', 'psg']);
  });

  it('treats a machine with no declaration as having none', () => {
    expect(presentSoundDevices(undefined, on())).toEqual([]);
  });
});

describe('soundDeviceMaxVolume', () => {
  it('defaults to 100 and honours a per-device ceiling', () => {
    expect(soundDeviceMaxVolume(BEEPER)).toBe(100);
    expect(soundDeviceMaxVolume(DAC)).toBe(200);
  });
});

describe('soundDeviceGains', () => {
  const devs = [BEEPER, PSG, DAC];

  it('maps each device\'s percent volume to a gain, defaulting to unity', () => {
    const g = soundDeviceGains(devs, view({ 'beeper-volume': 40, 'psg-volume': 75 }));
    expect(g.beeper).toBeCloseTo(0.4, 12);
    expect(g.psg).toBeCloseTo(0.75, 12);
    expect(soundDeviceGains(devs, view({})).beeper).toBe(1);
  });

  it('lets a device with a higher ceiling exceed unity, but only up to its ceiling', () => {
    expect(soundDeviceGains(devs, view({ dac: true, 'dac-volume': 150 })).dac).toBe(1.5);
    expect(soundDeviceGains(devs, view({ dac: true, 'dac-volume': 999 })).dac).toBe(2);
  });

  it('clamps a device without a higher ceiling to unity, and below to silence', () => {
    const g = soundDeviceGains(devs, view({ 'beeper-volume': 250, 'psg-volume': -10 }));
    expect(g.beeper).toBe(1);
    expect(g.psg).toBe(0);
  });

  it('treats a non-numeric saved value as unity rather than NaN', () => {
    expect(soundDeviceGains(devs, view({ 'beeper-volume': 'loud' })).beeper).toBe(1);
  });

  it('a lone device plays at unity whatever its stale volume says (it has no slider)', () => {
    // Only the beeper is present: the DAC is not fitted and there is no PSG on this machine.
    const g = soundDeviceGains([BEEPER, DAC], view({ 'beeper-volume': 10, 'dac-volume': 10 }));
    expect(g.beeper).toBe(1);
    expect(g.dac).toBe(1);
  });

  it('applies the volumes as soon as a second device is present', () => {
    const g = soundDeviceGains([BEEPER, DAC], view({ dac: true, 'beeper-volume': 10, 'dac-volume': 50 }));
    expect(g.beeper).toBeCloseTo(0.1, 12);
    expect(g.dac).toBeCloseTo(0.5, 12);
  });
});

describe('what each machine declares', () => {
  const present = (d: { ui: { soundDevices?: readonly SoundDeviceInfo[] } }, ...enabled: string[]) =>
    ids(presentSoundDevices(d.ui.soundDevices, on(...enabled)));

  it('a 48K has only the beeper until a SpecDrum or µSpeech is fitted', () => {
    const d = spectrumDescriptor('zx48k');
    expect(present(d)).toEqual(['beeper']);
    expect(present(d, 'specdrum')).toEqual(['beeper', 'specdrum']);
    expect(present(d, 'uspeech')).toEqual(['beeper', 'uspeech']);
    expect(present(d, 'specdrum', 'uspeech')).toEqual(['beeper', 'specdrum', 'uspeech']);
  });

  it('a 128K has the beeper and the AY, with the peripherals on top', () => {
    const d = spectrumDescriptor('zx128k');
    expect(present(d)).toEqual(['beeper', 'psg']);
    expect(present(d, 'specdrum')).toEqual(['beeper', 'psg', 'specdrum']);
    expect(d.ui.soundDevices!.find((x) => x.id === 'psg')!.label).toBe(d.ui.soundChip);
  });

  it('every model with an AY declares it, and the +2A/+3 cannot take a µSpeech', () => {
    for (const m of ['zx128k', 'zx128kplus2', 'zx128kplus2a', 'zx128kplus3', 'pentagon128', 'pentagon512', 'pentagon1024', 'scorpion256'] as const) {
      expect(present(spectrumDescriptor(m)), m).toContain('psg');
    }
    expect(present(spectrumDescriptor('zx128kplus3'), 'uspeech')).not.toContain('uspeech');
    expect(present(spectrumDescriptor('zx128kplus2a'), 'uspeech')).not.toContain('uspeech');
    expect(present(spectrumDescriptor('zx16k'))).not.toContain('psg');
  });

  it('the SpecDrum and µSpeech sliders reach 200 %, the beeper and AY stop at 100 %', () => {
    const by = Object.fromEntries(spectrumDescriptor('zx128k').ui.soundDevices!.map((x) => [x.id, soundDeviceMaxVolume(x)]));
    expect(by).toEqual({ beeper: 100, psg: 100, specdrum: 200, uspeech: 200 });
  });

  it('the Atari always has speaker and POKEY', () => {
    expect(present(atariDescriptor('atari800'))).toEqual(['beeper', 'psg']);
    expect(present(atariDescriptor('atari800xl'))).toEqual(['beeper', 'psg']);
  });

  it('the Apple II has a Mockingboard to weigh against the speaker only when it is fitted, and never on the //c', () => {
    expect(present(apple2Descriptor('apple2e'))).toEqual(['beeper']);
    expect(present(apple2Descriptor('apple2e'), 'apple2-mockingboard')).toEqual(['beeper', 'psg']);
    expect(present(apple2Descriptor('apple2c'), 'apple2-mockingboard')).toEqual(['beeper']);
  });

  it('machines whose only sound is one device declare no mix', () => {
    // Single-sound-chip and buzzer machines keep just master volume.
    for (const entry of registry) {
      for (const model of entry.models) {
        const devices = presentSoundDevices(entry.descriptor(model).ui.soundDevices, on());
        if (devices.length === 1) expect(devices[0]!.volumeSetting, `${model}`).toBe('beeper-volume');
      }
    }
  });

  it('every declared device has a unique id and volume key within its machine', () => {
    for (const entry of registry) {
      for (const model of entry.models) {
        const devices = entry.descriptor(model).ui.soundDevices ?? [];
        expect(new Set(devices.map((d) => d.id)).size, `${model} ids`).toBe(devices.length);
        expect(new Set(devices.map((d) => d.volumeSetting)).size, `${model} keys`).toBe(devices.length);
      }
    }
  });
});

describe('Spectrum applies the device volumes', () => {
  function make(model: SpectrumModel): Spectrum {
    const s = new Spectrum(model, null);
    s.loadROM(new Uint8Array(64 * 1024));
    return s;
  }

  it('sets the beeper and AY independently (no balance coupling)', () => {
    const s = make('zx128k');
    s.applySettings(view({ 'beeper-volume': 30, 'psg-volume': 60 }));
    expect(s.mixer.beeperGain).toBeCloseTo(0.3, 12);
    expect(s.mixer.ayGain).toBeCloseTo(0.6, 12);
    s.applySettings(view({ 'beeper-volume': 100, 'psg-volume': 0 }));
    expect([s.mixer.beeperGain, s.mixer.ayGain]).toEqual([1, 0]);
  });

  it('defaults to both at unity when nothing is saved', () => {
    const s = make('zx128k');
    s.applySettings(view({}));
    expect([s.mixer.beeperGain, s.mixer.ayGain]).toEqual([1, 1]);
  });

  it('a 48K on its own ignores a stale beeper volume: it has no slider to undo it', () => {
    const s = make('zx48k');
    s.applySettings(view({ 'beeper-volume': 10 }));
    expect(s.mixer.beeperGain).toBe(1);
  });

  it('the beeper volume applies on a 48K once a SpecDrum makes it a mix', () => {
    const s = make('zx48k');
    s.applySettings(view({ specdrum: true, 'beeper-volume': 10, 'specdrum-volume': 150 }));
    expect(s.mixer.beeperGain).toBeCloseTo(0.1, 12);
    expect(s.mixer.auxGain).toBeCloseTo(1.5, 12);
  });

  it('µSpeech has its own level, up to 200 %', () => {
    const s = make('zx48k');
    s.applySettings(view({ uspeech: true, 'uspeech-volume': 50 }));
    expect(s.mixer.monoGain).toBeCloseTo(0.5, 12);
    s.applySettings(view({ uspeech: true, 'uspeech-volume': 200 }));
    expect(s.mixer.monoGain).toBe(2);
    s.applySettings(view({ uspeech: true, 'uspeech-volume': 500 }));
    expect(s.mixer.monoGain).toBe(2);
  });

  it('turning µSpeech off returns the speech level to unity', () => {
    const s = make('zx48k');
    s.applySettings(view({ uspeech: true, 'uspeech-volume': 20 }));
    s.applySettings(view({ uspeech: false, 'uspeech-volume': 20 }));
    expect(s.mixer.monoGain).toBe(1);
  });
});

describe('Apple II applies the device volumes', () => {
  it('weighs the speaker against a fitted Mockingboard', () => {
    const m = new Apple2Machine('apple2e', null);
    try {
      m.prepare(view({ 'apple2-mockingboard': true }));
      m.applySettings(view({ 'apple2-mockingboard': true, 'beeper-volume': 25, 'psg-volume': 80 }));
      expect(m.mixer.beeperGain).toBeCloseTo(0.25, 12);
      expect(m.mixer.psgGain).toBeCloseTo(0.8, 12);
    } finally {
      m.destroy();
    }
  });

  it('leaves the speaker at unity when it is the only sound device', () => {
    const m = new Apple2Machine('apple2e', null);
    try {
      m.prepare(view({}));
      m.applySettings(view({ 'beeper-volume': 25 }));
      expect(m.mixer.beeperGain).toBe(1);
    } finally {
      m.destroy();
    }
  });
});
