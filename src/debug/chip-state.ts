/**
 * A machine's custom chips as a debugger sees them: a name, a one-line
 * description, and a dump of the chip's registers and decoded state.
 *
 * A machine offers them through `DebugService.chips()`. A dump reads the
 * chip's own state, never through the CPU's bus, so taking one does not clear
 * an interrupt flag or fire a watchpoint. This module imports nothing.
 */

export interface ChipSection {
  /** Short lower-case name used to pick the chip, e.g. "gtia". */
  readonly name: string;
  /** One line saying what the chip is. */
  readonly description: string;
  /** The chip's registers (address, name, value) and decoded fields as text. */
  dump(): string;
}

/** Pick sections by name: a comma list, matched case-insensitively. Returns
 *  the sections and the names that matched nothing. */
export function selectChips(all: readonly ChipSection[], names: string): { chosen: ChipSection[]; unknown: string[] } {
  const wanted = names.split(/[\s,]+/).filter(Boolean).map(n => n.toLowerCase());
  const chosen: ChipSection[] = [];
  const unknown: string[] = [];
  for (const w of wanted) {
    const hit = all.find(c => c.name.toLowerCase() === w);
    if (hit) { if (!chosen.includes(hit)) chosen.push(hit); } else unknown.push(w);
  }
  return { chosen, unknown };
}
