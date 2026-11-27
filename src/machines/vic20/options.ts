/**
 * VIC-20 hardware options: the expansion RAM on the cartridge port.
 *
 * Read from the shared settings (see `store/settings.ts`) when the machine
 * is prepared; changing one rebuilds the machine, as fitting a cartridge on
 * the real one means switching it off first.
 *
 * The sizes are the cartridges people had: Commodore's 3K (RAM1-3, $0400),
 * 8K and 16K, and 24K made of three 8K blocks (BLK1-3, $2000-$7FFF), with or
 * without the 3K as well. BLK5 ($A000) is apart: it is where cartridges go,
 * and some programs want RAM there.
 */

import type { SettingsView } from '@/machines/machine.ts';
import { VIC20_NO_EXPANSION, type Vic20RamExpansion } from './memory.ts';

export const VIC20_RAM_CHOICES = ['none', '3k', '8k', '16k', '24k', '27k'] as const;
export type Vic20RamChoice = typeof VIC20_RAM_CHOICES[number];

/** The Hardware pane's labels for each choice. */
export const VIC20_RAM_LABELS: Readonly<Record<Vic20RamChoice, string>> = {
  none: 'Unexpanded',
  '3k': '3K ($0400)',
  '8k': '8K (BLK1)',
  '16k': '16K (BLK1-2)',
  '24k': '24K (BLK1-3)',
  '27k': '3K + 24K',
};

export function isVic20RamChoice(value: unknown): value is Vic20RamChoice {
  return (VIC20_RAM_CHOICES as readonly unknown[]).includes(value);
}

/** The blocks a choice fits, with or without BLK5. */
export function vic20Expansion(choice: Vic20RamChoice, blk5: boolean): Vic20RamExpansion {
  const blocks = choice === '8k' ? 1 : choice === '16k' ? 2 : choice === '24k' || choice === '27k' ? 3 : 0;
  return {
    ...VIC20_NO_EXPANSION,
    ram123: choice === '3k' || choice === '27k',
    blk1: blocks >= 1,
    blk2: blocks >= 2,
    blk3: blocks >= 3,
    blk5,
  };
}

/** The choice that fits `exp`'s RAM1-3 and BLK1-3, or null when none does
 *  (BLK2 without BLK1, say). */
export function vic20RamChoiceFor(exp: Vic20RamExpansion): Vic20RamChoice | null {
  for (const c of VIC20_RAM_CHOICES) {
    const e = vic20Expansion(c, exp.blk5);
    if (e.ram123 === exp.ram123 && e.blk1 === exp.blk1 && e.blk2 === exp.blk2 && e.blk3 === exp.blk3) return c;
  }
  return null;
}

export function readVic20Expansion(view: SettingsView): Vic20RamExpansion {
  const raw = view.get<string>('vic20-ram', 'none');
  return vic20Expansion(isVic20RamChoice(raw) ? raw : 'none', view.get('vic20-blk5', false));
}

/** Where BASIC starts with `exp` fitted: $1201 with BLK1, $0401 with the 3K
 *  alone, else $1001. */
export function vic20BasicStart(exp: Vic20RamExpansion): number {
  return exp.blk1 ? 0x1201 : exp.ram123 ? 0x0401 : 0x1001;
}

/**
 * The expansion RAM a program loaded at `start`, `length` bytes long, needs,
 * or null when what is fitted (`current`) will do.
 *
 * A program at one of BASIC's three starting places is a BASIC program (or a
 * machine-code one behind a SYS line) written for that memory: $1001 for an
 * unexpanded machine, $0401 for the 3K, $1201 for 8K or more (as many blocks
 * as it reaches into). Anywhere else, the RAM under the program is fitted,
 * keeping what is fitted already. BLK1-3 come in order (8K, 16K, 24K), so a
 * program in BLK3 gets all three.
 */
export function vic20ExpansionFor(start: number, length: number, current: Vic20RamExpansion): Vic20RamExpansion | null {
  const end = start + length;
  const blocksTo = (top: number): number => (top <= 0x2000 ? 0 : top <= 0x4000 ? 1 : top <= 0x6000 ? 2 : 3);
  let want: Vic20RamExpansion;
  if (start === 0x1001 || start === 0x0401 || start === 0x1201) {
    const blocks = start === 0x1201 ? Math.max(1, blocksTo(Math.min(end, 0x8000))) : 0;
    const haveBlocks = (current.blk1 ? 1 : 0) + (current.blk1 && current.blk2 ? 1 : 0) + (current.blk1 && current.blk2 && current.blk3 ? 1 : 0);
    if (vic20BasicStart(current) === start && haveBlocks >= blocks) return null;
    const choice: Vic20RamChoice = start === 0x0401 ? '3k' : start === 0x1001 ? 'none'
      : blocks === 1 ? '8k' : blocks === 2 ? '16k' : '24k';
    want = vic20Expansion(choice, current.blk5);
  } else {
    const overlaps = (lo: number, hi: number): boolean => start < hi && end > lo;
    const blocks = overlaps(0x2000, 0x8000) ? blocksTo(Math.min(end, 0x8000)) : 0;
    const have = vic20RamChoiceFor(current);
    const ram123 = current.ram123 || overlaps(0x0400, 0x1000);
    const curBlocks = current.blk3 ? 3 : current.blk2 ? 2 : current.blk1 ? 1 : 0;
    const n = Math.max(blocks, have ? curBlocks : 0);
    // The 3K with one or two blocks is not a cartridge set: take all three.
    const choice: Vic20RamChoice = ram123 ? (n === 0 ? '3k' : '27k') : (['none', '8k', '16k', '24k'] as const)[n];
    want = vic20Expansion(choice, current.blk5 || overlaps(0xA000, 0xC000));
  }
  const same = want.ram123 === current.ram123 && want.blk1 === current.blk1 && want.blk2 === current.blk2
    && want.blk3 === current.blk3 && want.blk5 === current.blk5;
  return same ? null : want;
}
