import { describe, it, expect, beforeEach } from 'vitest';
import { SymbolTable, SymbolEntry } from '@/debug/symbols.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a realistic sjasmplus .lst line for a label. */
function labelLine(lineNum: number, addr: number, bytes: number[], name: string, rest = ''): string {
  const ln = String(lineNum).padStart(6);
  const a = addr.toString(16).toUpperCase().padStart(4, '0');
  const bs = bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const gap = bs.length ? ` ${bs}` : '';
  return `${ln}    ${a}${gap}  ${name}:${rest}`;
}

/** Build a realistic sjasmplus .lst line for an EQU. */
function equLine(lineNum: number, addr: number, name: string, value: string, comment = ''): string {
  const ln = String(lineNum).padStart(6);
  const a = addr.toString(16).toUpperCase().padStart(4, '0');
  const c = comment ? ` ; ${comment}` : '';
  return `${ln}    ${a}  ${name}  equ  ${value}${c}`;
}

// ── SymbolTable — construction & basic API ────────────────────────────────────

describe('SymbolTable — initial state', () => {
  it('starts empty', () => {
    const t = new SymbolTable();
    expect(t.size).toBe(0);
    expect(t.source).toBeNull();
  });

  it('lookup returns undefined for unknown name', () => {
    expect(new SymbolTable().lookup('ANYTHING')).toBeUndefined();
  });

  it('entries() returns empty array when empty', () => {
    expect(new SymbolTable().entries()).toEqual([]);
  });
});

// ── clear() ──────────────────────────────────────────────────────────────────

describe('SymbolTable.clear()', () => {
  it('removes all symbols and resets source', () => {
    const t = new SymbolTable();
    t.loadLst(labelLine(1, 0x4000, [0x21], 'Start'), 'prog.lst');
    expect(t.size).toBe(1);
    t.clear();
    expect(t.size).toBe(0);
    expect(t.source).toBeNull();
    expect(t.lookup('Start')).toBeUndefined();
  });
});

// ── loadLst — label parsing ───────────────────────────────────────────────────

describe('loadLst — label lines', () => {
  let t: SymbolTable;
  beforeEach(() => { t = new SymbolTable(); });

  it('parses a label with no byte columns', () => {
    const { labels } = t.loadLst(labelLine(1, 0x4000, [], 'Entry'), 'f.lst');
    expect(labels).toBe(1);
    const s = t.lookup('Entry');
    expect(s).toMatchObject<Partial<SymbolEntry>>({ name: 'Entry', value: 0x4000, kind: 'label' });
  });

  it('parses a label with one byte column', () => {
    t.loadLst(labelLine(1, 0x0000, [0x00], 'Nop'), 'f.lst');
    expect(t.lookup('Nop')?.value).toBe(0x0000);
  });

  it('parses a label with three byte columns (JP instruction)', () => {
    t.loadLst(labelLine(1, 0x8000, [0xC3, 0x00, 0x40], 'Main'), 'f.lst');
    expect(t.lookup('Main')?.value).toBe(0x8000);
  });

  it('parses a label with four byte columns', () => {
    t.loadLst(labelLine(1, 0x8000, [0x21, 0xFF, 0xFF, 0x00], 'LD_HL'), 'f.lst');
    expect(t.lookup('LD_HL')?.value).toBe(0x8000);
  });

  it('parses label at address 0x0000', () => {
    t.loadLst(labelLine(1, 0x0000, [], 'Zero'), 'f.lst');
    expect(t.lookup('Zero')?.value).toBe(0x0000);
  });

  it('parses label at address 0xFFFF', () => {
    t.loadLst(labelLine(1, 0xFFFF, [], 'Top'), 'f.lst');
    expect(t.lookup('Top')?.value).toBe(0xFFFF);
  });

  it('parses label name starting with underscore', () => {
    t.loadLst(labelLine(1, 0x1000, [], '_local'), 'f.lst');
    expect(t.lookup('_local')?.value).toBe(0x1000);
  });

  it('parses label with digits in its name', () => {
    t.loadLst(labelLine(1, 0x2000, [], 'wait_1'), 'f.lst');
    expect(t.lookup('wait_1')?.value).toBe(0x2000);
  });

  it('accepts sjasmplus include-marker lines (line++ suffix)', () => {
    // sjasmplus marks lines from included files with `+` after the number
    const line = `   123+    8000 C3 00 40  Include_Label:  jp 0x8000`;
    t.loadLst(line, 'f.lst');
    expect(t.lookup('Include_Label')?.value).toBe(0x8000);
  });

  it('accepts multiple + markers', () => {
    const line = `   123+++  8000  Multi_Plus:`;
    t.loadLst(line, 'f.lst');
    expect(t.lookup('Multi_Plus')?.value).toBe(0x8000);
  });

  it('records kind as "label"', () => {
    t.loadLst(labelLine(1, 0x4000, [], 'L'), 'f.lst');
    expect(t.lookup('L')?.kind).toBe('label');
  });

  it('label with trailing instruction text after colon is parsed correctly', () => {
    // The colon terminates the name; everything after is irrelevant to the regex
    const line = `     1    4000 21 00 40  Start:  ld hl, 0x4000`;
    t.loadLst(line, 'f.lst');
    expect(t.lookup('Start')?.value).toBe(0x4000);
  });

  it('ignores lines that do not match label or equ format', () => {
    const text = [
      `     1    0000                         ; pure comment`,
      `     2    0000 C3 00 40                jp  0x4000`,
      `This is not a list file line at all`,
    ].join('\n');
    const { labels, equs } = t.loadLst(text, 'f.lst');
    expect(labels).toBe(0);
    expect(equs).toBe(0);
    expect(t.size).toBe(0);
  });

  it('does not match a name starting with a digit', () => {
    // Assembly labels cannot start with a digit; the regex should not capture one
    const line = `     1    0000  1label:`;
    t.loadLst(line, 'f.lst');
    expect(t.size).toBe(0);
  });
});

// ── loadLst — label with hex-looking name (backtracking) ─────────────────────

describe('loadLst — label names that look like hex bytes', () => {
  it('correctly identifies FADE as label even when preceded by byte FA DE', () => {
    // bytes FA DE look like hex, and FADE starts with FA — regex must backtrack
    const line = `     1    8000 FA DE  FADE:`;
    const t = new SymbolTable();
    t.loadLst(line, 'f.lst');
    expect(t.lookup('FADE')?.value).toBe(0x8000);
  });

  it('correctly identifies DEAD as label even when preceded by byte DE AD', () => {
    const line = `     1    8000 DE AD  DEAD:`;
    const t = new SymbolTable();
    t.loadLst(line, 'f.lst');
    expect(t.lookup('DEAD')?.value).toBe(0x8000);
  });
});

// ── loadLst — dot-prefix scope stripping ──────────────────────────────────────

describe('loadLst — scoped (module.local) labels', () => {
  it('strips a leading dot from a .local label', () => {
    // sjasmplus emits local labels as  `.label:` — the \.? in RE_LABEL eats the dot
    const line = `     1    4010  .loop:`;
    const t = new SymbolTable();
    t.loadLst(line, 'f.lst');
    // The dot is consumed; the symbol is stored as 'loop', not '.loop'
    expect(t.lookup('loop')?.value).toBe(0x4010);
    expect(t.lookup('.loop')).toBeUndefined();
  });

  it('module-scoped label: stored under the full dotted name', () => {
    // sjasmplus MODULE foo produces 'foo.label:' in the listing.
    // The leading \.? consumes nothing (no leading dot here), and the
    // IDENT pattern captures the full qualified name 'foo.label'.
    const line = `     1    4020  foo.label:`;
    const t = new SymbolTable();
    t.loadLst(line, 'f.lst');
    expect(t.lookup('foo.label')?.value).toBe(0x4020);
    expect(t.lookup('label')).toBeUndefined();
  });

  it('deeply nested module label is captured whole', () => {
    const line = `     1    5000  mod.sub.inner:`;
    const t = new SymbolTable();
    t.loadLst(line, 'f.lst');
    expect(t.lookup('mod.sub.inner')?.value).toBe(0x5000);
  });
});

// ── loadLst — EQU parsing ────────────────────────────────────────────────────

describe('loadLst — EQU numeric formats', () => {
  let t: SymbolTable;
  beforeEach(() => { t = new SymbolTable(); });

  it('parses decimal EQU', () => {
    t.loadLst(equLine(1, 0x0000, 'SCREEN', '16384'), 'f.lst');
    expect(t.lookup('SCREEN')).toMatchObject({ value: 16384, kind: 'equ' });
  });

  it('parses 0x-prefix hex EQU', () => {
    t.loadLst(equLine(1, 0x4000, 'SCREEN', '0x4000'), 'f.lst');
    expect(t.lookup('SCREEN')?.value).toBe(0x4000);
  });

  it('parses $-prefix hex EQU', () => {
    t.loadLst(equLine(1, 0x4000, 'SCREEN', '$4000'), 'f.lst');
    expect(t.lookup('SCREEN')?.value).toBe(0x4000);
  });

  it('parses h-suffix hex EQU (lowercase h)', () => {
    t.loadLst(equLine(1, 0x4000, 'SCREEN', '4000h'), 'f.lst');
    expect(t.lookup('SCREEN')?.value).toBe(0x4000);
  });

  it('parses H-suffix hex EQU (uppercase H — regex has /i flag)', () => {
    t.loadLst(equLine(1, 0x4000, 'SCREEN', '4000H'), 'f.lst');
    expect(t.lookup('SCREEN')?.value).toBe(0x4000);
  });

  it('parses EQU value of zero', () => {
    t.loadLst(equLine(1, 0x0000, 'NULL_CONST', '0'), 'f.lst');
    expect(t.lookup('NULL_CONST')?.value).toBe(0);
  });

  it('parses EQU with comment stripped', () => {
    t.loadLst(equLine(1, 0xFFFF, 'TOP', '0xFFFF', 'top of RAM'), 'f.lst');
    expect(t.lookup('TOP')?.value).toBe(0xFFFF);
  });

  it('records kind as "equ"', () => {
    t.loadLst(equLine(1, 0, 'K', '42'), 'f.lst');
    expect(t.lookup('K')?.kind).toBe('equ');
  });

  it('EQU keyword is case-insensitive (EQU)', () => {
    const line = `     1    0000  HIGH_BYTE  EQU  0xFF`;
    t.loadLst(line, 'f.lst');
    expect(t.lookup('HIGH_BYTE')?.value).toBe(0xFF);
  });

  it('EQU keyword is case-insensitive (Equ)', () => {
    const line = `     1    0000  MixedCase  Equ  0x10`;
    t.loadLst(line, 'f.lst');
    expect(t.lookup('MixedCase')?.value).toBe(0x10);
  });
});

// ── loadLst — EQU expressions that should be skipped ─────────────────────────

describe('loadLst — EQU skipped (non-literal) values', () => {
  let t: SymbolTable;
  beforeEach(() => { t = new SymbolTable(); });

  it('skips arithmetic expression', () => {
    const { skippedEqu, equs } = t.loadLst(equLine(1, 0, 'EXPR', '4+4'), 'f.lst');
    expect(equs).toBe(0);
    expect(skippedEqu).toBe(1);
    expect(t.lookup('EXPR')).toBeUndefined();
  });

  it('skips symbol-reference expression', () => {
    const { skippedEqu } = t.loadLst(equLine(1, 0, 'END', 'START+100'), 'f.lst');
    expect(skippedEqu).toBe(1);
    expect(t.lookup('END')).toBeUndefined();
  });

  it('skips binary (%) literal — not in parseLiteral', () => {
    const { skippedEqu } = t.loadLst(equLine(1, 0, 'FLAGS', '%10101010'), 'f.lst');
    expect(skippedEqu).toBe(1);
    expect(t.lookup('FLAGS')).toBeUndefined();
  });

  it('parses negative decimal EQU', () => {
    const { equs, skippedEqu } = t.loadLst(equLine(1, 0, 'MINUS_ONE', '-1'), 'f.lst');
    expect(equs).toBe(1);
    expect(skippedEqu).toBe(0);
    expect(t.lookup('MINUS_ONE')?.value).toBe(-1);
  });

  it('parses negative hex EQU (0x prefix)', () => {
    const { equs } = t.loadLst(equLine(1, 0, 'NEG', '-0x10'), 'f.lst');
    expect(equs).toBe(1);
    expect(t.lookup('NEG')?.value).toBe(-16);
  });

  it('parses negative $ prefix hex EQU', () => {
    t.loadLst(equLine(1, 0, 'N', '-$FF'), 'f.lst');
    expect(t.lookup('N')?.value).toBe(-255);
  });

  it('skips current-address ($) without digits', () => {
    // Bare `$` is not a valid hex value (needs at least one digit after $)
    const { skippedEqu } = t.loadLst(equLine(1, 0x1000, 'HERE', '$'), 'f.lst');
    expect(skippedEqu).toBe(1);
  });
});

// ── loadLst — return counts ───────────────────────────────────────────────────

describe('loadLst — return counts', () => {
  it('returns zero counts for empty text', () => {
    const t = new SymbolTable();
    const r = t.loadLst('', 'empty.lst');
    expect(r).toEqual({ labels: 0, equs: 0, skippedEqu: 0 });
  });

  it('counts labels and equs independently', () => {
    const text = [
      labelLine(1, 0x4000, [0xC3], 'Start'),
      labelLine(2, 0x4003, [], 'Loop'),
      equLine(3, 0x0000, 'SCREEN', '0x4000'),
      equLine(4, 0x0000, 'ATTRS', '$5800'),
      equLine(5, 0x0000, 'SKIPPED', 'A+B'),
    ].join('\n');
    const r = new SymbolTable().loadLst(text, 'f.lst');
    expect(r.labels).toBe(2);
    expect(r.equs).toBe(2);
    expect(r.skippedEqu).toBe(1);
  });
});

// ── loadLst — merge / overwrite behaviour ────────────────────────────────────

describe('loadLst — merge behaviour', () => {
  it('second call overwrites existing symbol with same name', () => {
    const t = new SymbolTable();
    t.loadLst(labelLine(1, 0x4000, [], 'Main'), 'first.lst');
    t.loadLst(labelLine(1, 0x8000, [], 'Main'), 'second.lst');
    expect(t.lookup('Main')?.value).toBe(0x8000);
    expect(t.size).toBe(1);
  });

  it('second call adds new symbols without removing old ones', () => {
    const t = new SymbolTable();
    t.loadLst(labelLine(1, 0x4000, [], 'Alpha'), 'first.lst');
    t.loadLst(labelLine(1, 0x5000, [], 'Beta'), 'second.lst');
    expect(t.size).toBe(2);
    expect(t.lookup('Alpha')?.value).toBe(0x4000);
    expect(t.lookup('Beta')?.value).toBe(0x5000);
  });

  it('source is updated to the most recently loaded file', () => {
    const t = new SymbolTable();
    t.loadLst(labelLine(1, 0x4000, [], 'A'), 'first.lst');
    expect(t.source).toBe('first.lst');
    t.loadLst(labelLine(1, 0x5000, [], 'B'), 'second.lst');
    expect(t.source).toBe('second.lst');
  });

  it('equ can overwrite a label from a previous load', () => {
    const t = new SymbolTable();
    t.loadLst(labelLine(1, 0x4000, [], 'FOO'), 'a.lst');
    t.loadLst(equLine(1, 0, 'FOO', '0x1234'), 'b.lst');
    expect(t.lookup('FOO')).toMatchObject({ value: 0x1234, kind: 'equ' });
  });
});

// ── lookup — case sensitivity ─────────────────────────────────────────────────

describe('lookup — case sensitivity', () => {
  it('is case-sensitive: Start and start are different', () => {
    const t = new SymbolTable();
    t.loadLst(labelLine(1, 0x4000, [], 'Start'), 'f.lst');
    expect(t.lookup('Start')?.value).toBe(0x4000);
    expect(t.lookup('start')).toBeUndefined();
    expect(t.lookup('START')).toBeUndefined();
  });
});

// ── entries() ────────────────────────────────────────────────────────────────

describe('entries()', () => {
  it('returns all symbols sorted by name', () => {
    const t = new SymbolTable();
    const text = [
      labelLine(1, 0x4000, [], 'Zebra'),
      labelLine(2, 0x5000, [], 'Alpha'),
      equLine(3, 0, 'Midpoint', '0x4800'),
    ].join('\n');
    t.loadLst(text, 'f.lst');
    const names = t.entries().map(e => e.name);
    expect(names).toEqual(['Alpha', 'Midpoint', 'Zebra']);
  });

  it('entries() returns a new array each call (not the internal map)', () => {
    const t = new SymbolTable();
    t.loadLst(labelLine(1, 0x4000, [], 'X'), 'f.lst');
    const a = t.entries();
    const b = t.entries();
    expect(a).not.toBe(b);
  });
});

// ── loadLst — source tracking ─────────────────────────────────────────────────

describe('loadLst — source tracking', () => {
  it('sets source after first load', () => {
    const t = new SymbolTable();
    t.loadLst('', 'prog.lst');
    expect(t.source).toBe('prog.lst');
  });
});

// ── loadLst — multi-line / CRLF ──────────────────────────────────────────────

describe('loadLst — line endings', () => {
  it('handles CRLF line endings', () => {
    const t = new SymbolTable();
    const lines = [labelLine(1, 0x4000, [], 'A'), labelLine(2, 0x5000, [], 'B')].join('\r\n');
    t.loadLst(lines, 'f.lst');
    expect(t.size).toBe(2);
  });

  it('handles LF-only line endings', () => {
    const t = new SymbolTable();
    const lines = [labelLine(1, 0x4000, [], 'A'), equLine(2, 0, 'B', '0x5000')].join('\n');
    t.loadLst(lines, 'f.lst');
    expect(t.size).toBe(2);
  });
});

// ── realistic .lst snippet ────────────────────────────────────────────────────

describe('loadLst — realistic sjasmplus output', () => {
  const LST = `\
     1    0000
     2    0000           SCREEN      equ     0x4000     ; display file
     3    0000           ATTRS       equ     $5800      ; attribute file
     4    0000           FRAMES      equ     23672      ; decimal
     5    0000           ENTRY_HEX   equ     4000h      ; h-suffix
     6    0000           EXPR_SKIP   equ     SCREEN+32  ; expression — skip
     7    4000
     8    4000 21 00 40  Start:      ld      hl,SCREEN
     9    4003 C3 00 40  .loop:      jp      .loop
    10    4006
`;

  it('parses a realistic lst snippet correctly', () => {
    const t = new SymbolTable();
    const r = t.loadLst(LST, 'prog.lst');

    expect(r.equs).toBe(4);
    expect(r.labels).toBe(2);
    expect(r.skippedEqu).toBe(1);

    expect(t.lookup('SCREEN')?.value).toBe(0x4000);
    expect(t.lookup('ATTRS')?.value).toBe(0x5800);
    expect(t.lookup('FRAMES')?.value).toBe(23672);
    expect(t.lookup('ENTRY_HEX')?.value).toBe(0x4000);
    expect(t.lookup('EXPR_SKIP')).toBeUndefined();

    expect(t.lookup('Start')?.value).toBe(0x4000);
    expect(t.lookup('Start')?.kind).toBe('label');

    // .loop: — the leading dot is consumed (not captured), stored as 'loop'
    expect(t.lookup('loop')?.value).toBe(0x4003);
  });
});
