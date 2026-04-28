/**
 * Symbol table loaded from an sjasmplus `.lst` file.
 *
 * Two definition shapes are recognised on each list line:
 *
 *   1. Label:   `<line> <addr> [<bytes>] name:` — value is the address column.
 *   2. EQU:     `<line> <addr> name equ <value>` — value is the equ expression.
 *               Only literal numeric values are evaluated (hex/decimal); any
 *               expression we can't resolve is silently skipped.
 *
 * The address shown for a label is the assembled address. When code is paged
 * to a different runtime slot (e.g. bank 4 assembled at 0000 but executed
 * via slot 0), the symbol still resolves to the assembled address — callers
 * are responsible for ensuring the right banking context.
 */

export interface SymbolEntry {
  name: string;
  value: number;
  /** 'label' for `name:` definitions, 'equ' for `name equ ...`. */
  kind: 'label' | 'equ';
}

// Regex anchors:
//   ^\s*\d+\+*           leading line number (sjasmplus marks include/macro lines with `+`)
//   \s+([0-9A-Fa-f]{4})  4-hex address column (captured)
//   (?:\s+[0-9A-Fa-f]{2})*   any number of byte columns (each is 2 hex chars)
//   \s+\.?(\w+):         optional dot-prefix scope, identifier, colon
const RE_LABEL = /^\s*\d+\+*\s+([0-9A-Fa-f]{4})(?:\s+[0-9A-Fa-f]{2})*\s+\.?([A-Za-z_]\w*):/;
const RE_EQU   = /^\s*\d+\+*\s+[0-9A-Fa-f]{4}\s+\.?([A-Za-z_]\w*)\s+equ\s+([^;]+?)\s*(?:;.*)?$/i;

/** Parse a literal numeric value as written in an sjasmplus equ. Returns null for expressions we can't evaluate. */
function parseLiteral(s: string): number | null {
  s = s.trim();
  if (/^0x[0-9A-Fa-f]+$/.test(s))    return parseInt(s.slice(2), 16);
  if (/^\$[0-9A-Fa-f]+$/.test(s))    return parseInt(s.slice(1), 16);
  if (/^[0-9A-Fa-f]+h$/i.test(s))    return parseInt(s.slice(0, -1), 16);
  if (/^[0-9]+$/.test(s))            return parseInt(s, 10);
  return null;
}

export class SymbolTable {
  private byName = new Map<string, SymbolEntry>();
  /** Path of the most recently loaded file (for diagnostics). */
  source: string | null = null;

  /** Drop all symbols. */
  clear(): void {
    this.byName.clear();
    this.source = null;
  }

  /** Number of symbols currently loaded. */
  get size(): number { return this.byName.size; }

  /** Look up a symbol by name (case-sensitive). */
  lookup(name: string): SymbolEntry | undefined {
    return this.byName.get(name);
  }

  /** Iterate all symbols sorted by name. */
  entries(): SymbolEntry[] {
    return [...this.byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Parse sjasmplus `.lst` text. Returns counts for diagnostics. Existing
   * symbols are merged — re-loading the same file replaces in place.
   */
  loadLst(text: string, source: string): { labels: number; equs: number; skippedEqu: number } {
    let labels = 0, equs = 0, skippedEqu = 0;
    for (const line of text.split(/\r?\n/)) {
      const mLabel = RE_LABEL.exec(line);
      if (mLabel) {
        const addr = parseInt(mLabel[1], 16);
        this.byName.set(mLabel[2], { name: mLabel[2], value: addr, kind: 'label' });
        labels++;
        continue;
      }
      const mEqu = RE_EQU.exec(line);
      if (mEqu) {
        const val = parseLiteral(mEqu[2]);
        if (val === null) { skippedEqu++; continue; }
        this.byName.set(mEqu[1], { name: mEqu[1], value: val, kind: 'equ' });
        equs++;
      }
    }
    this.source = source;
    return { labels, equs, skippedEqu };
  }
}
