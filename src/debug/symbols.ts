/**
 * Symbol table loaded from an sjasmplus `.lst` file.
 *
 * Two definition shapes are recognised on each list line:
 *
 *   1. Label:   `<line> <addr> [<bytes>] name:` — value is the address column.
 *   2. EQU:     `<line> <addr> name equ <value>` — value is the equ expression.
 *               Literal numeric values (hex/decimal, optionally signed) are
 *               evaluated; expressions we can't resolve are silently skipped.
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
//   ^\s*\d+\+*                  leading line number (sjasmplus marks include/macro lines with `+`)
//   \s+([0-9A-Fa-f]{4})         4-hex address column (captured)
//   (?:\s+[0-9A-Fa-f]{2})*      any number of byte columns (each is 2 hex chars)
//   \s+\.?(<ident>(?:\.<ident>)*):  optional dot-prefix scope, dotted identifier, colon
//                               The leading dot (local label) is consumed but not captured;
//                               module-qualified names like `foo.label` are captured whole.
const IDENT = String.raw`[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*`;
const RE_LABEL = new RegExp(String.raw`^\s*\d+\+*\s+([0-9A-Fa-f]{4})(?:\s+[0-9A-Fa-f]{2})*\s+\.?(${IDENT}):`);
const RE_EQU   = new RegExp(String.raw`^\s*\d+\+*\s+[0-9A-Fa-f]{4}\s+\.?(${IDENT})\s+equ\s+([^;]+?)\s*(?:;.*)?$`, 'i');

/** Parse a literal numeric value as written in an sjasmplus equ. Returns null for expressions we can't evaluate. */
function parseLiteral(s: string): number | null {
  s = s.trim();
  const neg = s.startsWith('-');
  const u = neg ? s.slice(1).trimStart() : s;
  let result: number | null = null;
  if (/^0x[0-9A-Fa-f]+$/.test(u))    result = parseInt(u.slice(2), 16);
  else if (/^\$[0-9A-Fa-f]+$/.test(u))    result = parseInt(u.slice(1), 16);
  else if (/^[0-9A-Fa-f]+h$/i.test(u))    result = parseInt(u.slice(0, -1), 16);
  else if (/^[0-9]+$/.test(u))            result = parseInt(u, 10);
  if (result === null) return null;
  return neg ? -result : result;
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
