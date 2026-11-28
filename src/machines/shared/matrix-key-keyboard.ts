/**
 * The keyboard matrix the ZX machines share.
 *
 * The Spectrum, the Jupiter Ace and the ZX80/81 all scan the same way, because
 * the ULA that does it came from the same designer: eight half-rows of five
 * bits, selected by the high byte of a port 0xFE read (a 0 bit selects the row),
 * keys active-low. The Ace differs only in which key sits at which cell and in
 * having a dedicated SYMBOL SHIFT (`{ row: 0, bit: 1 }`); the Spectrum folds
 * that onto CAPS SHIFT + key. The ZX80/81 has no symbol shift at all and mirrors
 * SHIFT onto both shifts.
 *
 * What they do NOT differ in is the matrix itself and how a host keystroke
 * becomes cell presses: the reference-counted bits (several sources may hold one
 * cell — the on-screen SHIFT and a physical Shift both press `[0,0]`), the
 * one-frame stagger that lets a modifier land before the key it modifies, the
 * CHAR_MAP combos for characters the real keyboard lacks, and the CAPS SHIFT
 * suppression that stops a symbol combo entering extended mode by accident.
 *
 * So the maps live in each machine's own `keyboard.ts` and this class does the
 * scanning and the event handling for all three.
 */

/** One matrix cell. */
export interface KeyMapping {
  row: number;
  bit: number;
}

/** A key made of several cells — a modifier plus the key it modifies. */
export type ComboMapping = KeyMapping[];

/** What a machine's `keyboard.ts` supplies. */
export interface KeyTables {
  /** Physical key code → cell or chord. */
  readonly keyMap: Readonly<Record<string, KeyMapping | ComboMapping>>;
  /**
   * Character → chord, for the printable symbols the real keyboard cannot type
   * directly (they need SYMBOL SHIFT on the Spectrum and the Ace).
   *
   * Optional: the ZX80/81 has no symbol shift and no such table.
   */
  readonly charMap?: Readonly<Record<string, ComboMapping>>;
  /**
   * The cell that means "CAPS SHIFT" — the shift a symbol combo suppresses so it
   * does not also trigger extended mode.
   *
   * Defaults to `[0, 0]` (the Spectrum's CAPS SHIFT and the Ace's SHIFT). A
   * machine with no symbol shift omits the whole CHAR_MAP anyway.
   */
  readonly capsShift?: KeyMapping;
}

const DEFAULT_CAPS_SHIFT: KeyMapping = { row: 0, bit: 0 };

export class MatrixKeyKeyboard {
  /** 8 half-row bytes, bits 0-4, active low (0 = pressed). */
  readonly rows: Uint8Array;

  /** Releasing a bare chord still releases it if a release arrives, even when
   *  the press was never seen (a key down before focus). */
  private readonly capsShift: KeyMapping;

  /** Track active CHAR_MAP combos by physical key code for correct release. */
  private readonly activeCharCombos = new Map<string, { combo: ComboMapping; suppressedCS: boolean }>();

  /** Physical Shift keys held (ShiftLeft only — the right shift is a modifier
   *  of its own on these machines). */
  private physicalShiftCount = 0;

  /** Keys deferred from combo presses — the modifier goes down immediately, and
   *  the remaining keys land one frame later so the scan always sees the
   *  modifier first. Cleared by processPending() each frame. */
  private pendingKeys: KeyMapping[] = [];

  /** Reference count per [row][bit]. Multiple sources can press the same bit
   *  (e.g. physical Shift + a Backspace combo both press CAPS SHIFT). The bit
   *  only releases when the count drops to zero. */
  private readonly pressCount: number[][];

  constructor(private readonly tables: KeyTables) {
    this.rows = new Uint8Array(8);
    this.rows.fill(0xFF);
    this.pressCount = Array.from({ length: 8 }, () => Array(5).fill(0));
    this.capsShift = tables.capsShift ?? DEFAULT_CAPS_SHIFT;
  }

  reset(): void {
    this.rows.fill(0xFF);
    this.activeCharCombos.clear();
    this.physicalShiftCount = 0;
    this.pendingKeys = [];
    for (const row of this.pressCount) row.fill(0);
  }

  /**
   * Apply deferred combo keys. Call once per frame (start of runFrame) so that
   * the modifier pressed on keydown is visible for one full scan before the main
   * key appears.
   */
  processPending(): void {
    for (const k of this.pendingKeys) this.setKey(k.row, k.bit, true);
    this.pendingKeys = [];
  }

  /**
   * Read half-rows selected by the high byte of the port address.
   * Multiple rows can be selected at once (active-low address lines).
   */
  readHalfRows(highByte: number): number {
    let result = 0xFF;
    for (let row = 0; row < 8; row++) {
      if ((highByte & (1 << row)) === 0) {
        result &= this.rows[row];
      }
    }
    return result & 0x1F;
  }

  setKey(row: number, bit: number, pressed: boolean): void {
    if (pressed) {
      this.pressCount[row][bit]++;
      this.rows[row] &= ~(1 << bit);
    } else {
      this.pressCount[row][bit] = Math.max(0, this.pressCount[row][bit] - 1);
      if (this.pressCount[row][bit] === 0) {
        this.rows[row] |= (1 << bit);
      }
    }
  }

  /** Temporarily suppress a bit (force release) without affecting the press
   *  count. Used by CHAR_MAP handling to hide CAPS SHIFT while a symbol combo is
   *  active, without confusing the reference count. */
  private suppressBit(row: number, bit: number): void {
    this.rows[row] |= (1 << bit);
  }

  /** Restore a previously suppressed bit — re-asserts it only if the press count
   *  says something is still holding it. */
  private restoreBit(row: number, bit: number): void {
    if (this.pressCount[row][bit] > 0) {
      this.rows[row] &= ~(1 << bit);
    }
  }

  /** Check if CAPS SHIFT is currently pressed (its cell active-low). */
  private get capsShiftPressed(): boolean {
    return (this.rows[this.capsShift.row] & (1 << this.capsShift.bit)) === 0;
  }

  handleKeyEvent(code: string, pressed: boolean, key?: string): boolean {
    // Track physical Shift so we know whether to restore CAPS SHIFT on release.
    // Only ShiftLeft: the right shift is a modifier of its own on these machines.
    if (code === 'ShiftLeft') {
      this.physicalShiftCount = Math.max(0, this.physicalShiftCount + (pressed ? 1 : -1));
    }

    // On release, use the stored combo from keydown so we release the correct
    // keys even if Shift state changed between press and release.
    if (!pressed) {
      const stored = this.activeCharCombos.get(code);
      if (stored) {
        for (const k of stored.combo) this.setKey(k.row, k.bit, false);
        // Restore CAPS SHIFT only if physical Shift is still held. If Shift was
        // released before this key, CAPS SHIFT was already cleared by the
        // ShiftLeft keyup event; restoring it here would leave it stuck.
        if (stored.suppressedCS && this.physicalShiftCount > 0) {
          this.restoreBit(this.capsShift.row, this.capsShift.bit);
        }
        this.activeCharCombos.delete(code);
        return true;
      }
    }

    // Check the character map for symbol keys (';', '-', ',', etc.).
    // Skip it for digit keys — Shift+number has machine meanings that must not be
    // intercepted by the symbol characters those PC keys produce (!@#$%^&*()).
    const isDigitKey = code.startsWith('Digit');
    const charMap = this.tables.charMap;
    const charMapping = (key && !isDigitKey && charMap) ? charMap[key] : undefined;
    if (charMapping) {
      if (pressed) {
        // If CAPS SHIFT is pressed (from physical Shift) but this combo doesn't
        // need it, suppress it so the combo does not also enter extended mode.
        const needsCS = charMapping.some(k => k.row === this.capsShift.row && k.bit === this.capsShift.bit);
        const suppressCS = this.capsShiftPressed && !needsCS;
        if (suppressCS) this.suppressBit(this.capsShift.row, this.capsShift.bit);
        this.activeCharCombos.set(code, { combo: charMapping, suppressedCS: suppressCS });
      }
      for (const k of charMapping) this.setKey(k.row, k.bit, pressed);
      return true;
    }

    const mapping = this.tables.keyMap[code];
    if (!mapping) return false;

    if (Array.isArray(mapping)) {
      if (pressed) {
        // Stagger: press the modifier (first key) immediately, defer the rest by
        // one frame so the keyboard scan always sees the modifier first. This
        // prevents e.g. Backspace (SHIFT+0) registering as just 0.
        this.setKey(mapping[0].row, mapping[0].bit, true);
        for (let ci = 1; ci < mapping.length; ci++) this.pendingKeys.push(mapping[ci]);
      } else {
        for (const k of mapping) this.setKey(k.row, k.bit, false);
      }
    } else {
      this.setKey(mapping.row, mapping.bit, pressed);
    }
    return true;
  }
}
