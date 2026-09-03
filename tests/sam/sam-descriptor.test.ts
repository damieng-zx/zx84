/**
 * The SAM Coupé registry entry and descriptor.
 *
 * Geometry expectations are derived from the hardware, not read back from the
 * constants module: the SAM's active display is 256 logical pixels wide (512 in
 * mode 3) by 192 lines, and the buffer is sampled at mode 3's resolution so a
 * single decoder path serves every mode. Everything else here is a contract the
 * generic panes rely on.
 */

import { describe, expect, it } from 'vitest';
import { samEntry, samDescriptor } from '@/machines/sam/descriptor.ts';
import { entryForModel, entryForKind, registry } from '@/machines/registry.ts';
import { isSamModel } from '@/machines/sam/models.ts';

describe('SAM registry entry', () => {
  it('registers all three models under the sam kind', () => {
    expect(samEntry.kind).toBe('sam');
    expect([...samEntry.models]).toEqual(['sam256', 'sam512', 'sam1m']);
    expect(entryForKind('sam')).toBe(samEntry);
    for (const model of samEntry.models) {
      expect(entryForModel(model)).toBe(samEntry);
    }
  });

  it('claims each of its models in exactly one registry entry', () => {
    for (const model of samEntry.models) {
      const owners = registry.filter(e => (e.models as readonly string[]).includes(model));
      expect(owners).toHaveLength(1);
    }
  });

  it('offers a single system ROM image', () => {
    // One source, not a page list: ROM 0 and ROM 1 are the two halves of one
    // 32K EPROM, which is why ui.romPages is 0.
    expect(samEntry.romSources('sam512')).toHaveLength(1);
    // The three models share one ROM — the megabyte interface is not a ROM change.
    expect(samEntry.romSources('sam256')).toEqual(samEntry.romSources('sam1m'));
    expect(samEntry.romSources('sam256')).toEqual(samEntry.romSources('sam512'));
  });

  it('has no cartridge port', () => {
    expect(samEntry.bootCartridgeSource).toBeUndefined();
  });
});

describe('SAM system-ROM detection', () => {
  it('accepts a 32K image while a SAM is already selected', () => {
    expect(samEntry.detectModelForRom!(new Uint8Array(32768), 'sam256')).toBe('sam256');
    expect(samEntry.detectModelForRom!(new Uint8Array(32768), 'sam1m')).toBe('sam1m');
  });

  it('rejects any image that is not exactly 32K', () => {
    for (const size of [0, 16384, 16385, 32767, 32769, 65536]) {
      expect(samEntry.detectModelForRom!(new Uint8Array(size), 'sam512')).toBeNull();
    }
  });

  it('does not claim a 32K ROM away from another machine family', () => {
    // A 32K image is equally a legal CPC OS+BASIC pair, so the SAM must not
    // grab one dropped while a CPC is selected.
    expect(samEntry.detectModelForRom!(new Uint8Array(32768), 'cpc6128')).toBeNull();
    expect(samEntry.detectModelForRom!(new Uint8Array(32768), '48k')).toBeNull();
  });
});

describe('SAM descriptor', () => {
  const d = samDescriptor('sam512');

  it('describes a Z80 machine of kind sam', () => {
    expect(d.kind).toBe('sam');
    expect(d.cpuFamily).toBe('z80');
    expect(d.model).toBe('sam512');
    expect(d.locale).toBe('uk');
  });

  it('centres a 512x192 active area in the 768x288 buffer', () => {
    expect(d.screen.width).toBe(768);
    expect(d.screen.height).toBe(288);
    expect(d.screen.activeWidth).toBe(512);
    expect(d.screen.activeHeight).toBe(192);
    // Borders must be exactly half the leftover in each axis.
    expect(d.screen.borderLeft).toBe((768 - 512) / 2);
    expect(d.screen.borderTop).toBe((288 - 192) / 2);
  });

  it('halves the pixel aspect, because the buffer is 2x oversampled', () => {
    // 768 x 0.5 = 384 presented pixels against 288 lines — exactly 4:3, the
    // correct PAL aspect. Mode 3's 512 pixels are therefore native.
    expect(d.screen.pixelAspectX).toBe(0.5);
    expect(d.screen.width * d.screen.pixelAspectX / d.screen.height).toBeCloseTo(4 / 3, 5);
  });

  it('declares SAM-specific UI capabilities the generic panes bind to', () => {
    expect(d.ui.colorMap).toBe('sam');
    expect(d.ui.builtinDisk).toBe(true);
    expect(d.ui.cartridge).toBe(false);
    expect(d.ui.beeper).toBe(true);
    expect(d.ui.tape).toBe('deck');
    expect(d.ui.keyboardBus).toBe('ula');
    // One physical 32K EPROM, so no independently-overridable ROM pages.
    expect(d.ui.romPages).toBe(0);
    // The Accuracy drop-down means per-t-state ULA rendering, which the SAM
    // has no equivalent of.
    expect(d.ui.accuracy).toBe(false);
  });

  it('is construction-free and identical for every model', () => {
    for (const model of samEntry.models) {
      const dm = samEntry.descriptor(model);
      expect(dm.kind).toBe('sam');
      expect(dm.screen).toEqual(d.screen);
      expect(dm.ui).toEqual(d.ui);
    }
  });
});

describe('isSamModel', () => {
  it('accepts every SAM model and rejects every other family', () => {
    for (const m of samEntry.models) expect(isSamModel(m)).toBe(true);
    for (const m of ['48k', '+3', 'cpc6128', 'hx-10', 'mtx512', 'zx81'] as const) {
      expect(isSamModel(m)).toBe(false);
    }
  });
});

describe('SAM save menu', () => {
  it('offers no snapshot format, because the SAM has none implemented', () => {
    // 'vdp' is the Save menu's no-snapshot arm (screenshot / screen / RAM).
    // 'spectrum' would offer .szx and .z80 entries that cannot be produced,
    // and the SAM has no snapshot service to answer them.
    expect(samDescriptor('sam512').ui.saveMenu).toBe('vdp');
  });

  it('has the exports that save menu actually needs', async () => {
    const { SamMachine } = await import('@/machines/sam/sam-machine.ts');
    const m = new SamMachine('sam512', null);
    expect(m.screenExportBytes().length).toBe(0x8000);
    expect(m.ramExportBytes().data.length).toBe(512 * 1024);
    m.destroy();
  });
});
