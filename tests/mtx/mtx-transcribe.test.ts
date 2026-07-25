import { describe, expect, it } from 'vitest';
import { MtxMachine } from '@/machines/mtx/mtx-machine.ts';
import { mtxDescriptor } from '@/machines/mtx/descriptor.ts';

function machine(): MtxMachine {
  const m = new MtxMachine('mtx512', null);
  m.reset();
  return m;
}

/**
 * The MTX shares the TMS9918 VDP with the MSX, so it can reuse the same
 * name-table OCR for the TEXT overlay. Previously MtxFrameProbe exposed no
 * transcribe driver and the descriptor omitted the 'text' status LED, so the
 * status bar showed no TEXT indicator and transcription never ran.
 */
describe('MTX text transcription (OCR)', () => {
  it('advertises the TEXT status LED', () => {
    expect(mtxDescriptor('mtx512').ui.statusLeds).toContain('text');
  });

  it('exposes a transcribe driver that toggles active via activate/deactivate', () => {
    const t = machine().services.probe.transcribe;
    expect(t).toBeDefined();
    expect(t!.active).toBe(false);
    t!.activate();
    expect(t!.active).toBe(true);
    t!.deactivate();
    expect(t!.active).toBe(false);
  });

  it('produces a styled OCR result from the VDP screen', () => {
    const r = machine().ocrScreenStyled();
    expect(typeof r.text).toBe('string');
    expect(typeof r.html).toBe('string');
    expect(Array.isArray(r.mask)).toBe(true);
  });
});
