/**
 * Spectrum on-demand inspection: the memory-layout pane (128K/+2/+2A/+3
 * paging), the BASIC listing and variables, the sysvars-pane flag, and the
 * Font pane's ROM-capture heuristic.
 *
 * Separate from the frame probe because these are asked for on demand and may
 * allocate, while `sample()` runs every rAF and must not.
 */

import type { MachineInspection, MemoryMapSnapshot } from '@/machines/machine.ts';
import type { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { isPlus2AClass } from '@/machines/spectrum/models.ts';
import { SPECIAL_MODES } from '@/machines/spectrum/memory.ts';
import { parseBasicProgram, parseBasicVariables } from '@/basic/sinclair-basic-parser.ts';
import { hex8 } from '@/utils/hex.ts';

/** Build the Spectrum memory-layout snapshot (128K/+2/+2A/+3 paging). */
function spectrumMemoryMap(s: Spectrum): MemoryMapSnapshot | null {
  const mem = s.memory;
  const plus2a = isPlus2AClass(s.model);

  const screenBank = (mem.port7FFD & 0x08) ? 7 : 5;
  const screenFlags = (bank: number): readonly ('screen')[] | undefined =>
    bank === screenBank ? ['screen'] : undefined;

  let slots;
  if (plus2a && mem.specialPaging) {
    // Special paging mode — all RAM. Mode selects one of four configurations.
    const [b0, b1, b2, b3] = SPECIAL_MODES[(mem.port1FFD >> 1) & 3];
    slots = [
      { range: 'C000-FFFF', read: `RAM Bank ${b3}`, flags: screenFlags(b3) },
      { range: '8000-BFFF', read: `RAM Bank ${b2}`, flags: screenFlags(b2) },
      { range: '4000-7FFF', read: `RAM Bank ${b1}`, flags: screenFlags(b1) },
      { range: '0000-3FFF', read: `RAM Bank ${b0}`, flags: screenFlags(b0) },
    ];
  } else {
    const romLabel = plus2a
      ? `ROM Page ${mem.currentROM}`
      : mem.currentROM === 0 ? '128K Editor ROM' : '48K BASIC ROM';
    slots = [
      { range: 'C000-FFFF', read: `RAM Bank ${mem.currentBank}`, flags: screenFlags(mem.currentBank) },
      { range: '8000-BFFF', read: 'RAM Bank 2' },
      { range: '4000-7FFF', read: 'RAM Bank 5', flags: screenFlags(5) },
      { range: '0000-3FFF', read: romLabel },
    ];
  }

  // Paging-register footer: 7FFD, optional 1FFD (+2A), and the lock latch.
  const registers = [{ name: '7FFD', value: hex8(mem.port7FFD) }];
  if (plus2a) registers.push({ name: '1FFD', value: hex8(mem.port1FFD) });
  registers.push({ name: 'Lock', value: mem.pagingLocked ? 'Y' : 'N' });

  return { slots, registers };
}

export class SpectrumInspection implements MachineInspection {
  readonly hasSysvars = true;

  constructor(private readonly spec: Spectrum) {}

  memoryMap(): MemoryMapSnapshot | null {
    return this.spec.variant.hasBanking ? spectrumMemoryMap(this.spec) : null;
  }

  basicListing() { return parseBasicProgram(this.spec.memory.snapshot()); }

  basicVars() { return parseBasicVariables(this.spec.memory.snapshot()); }

  /** Font-pane ROM capture: the current CHARS font, when its space glyph is
   *  blank (the heuristic that filters garbage). Hash-cache stays bridge-side. */
  romFontCandidate(): { fontStart: number; snap: Uint8Array } | null {
    const snap = this.spec.memory.snapshot();
    let charsAddr = snap[0x5C36] | (snap[0x5C37] << 8);
    if (charsAddr === 0) charsAddr = 0x3C00;
    const fontStart = charsAddr + 256;
    if (fontStart + 768 > 65536) return null;
    for (let i = 0; i < 8; i++) if (snap[fontStart + i] !== 0) return null;
    return { fontStart, snap };
  }
}
