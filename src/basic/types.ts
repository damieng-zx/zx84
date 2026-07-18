/**
 * Structured output of the BASIC parsers.
 *
 * The parsers return plain data — never HTML. Escaping and markup are the
 * rendering layer's job (the debug panes use Solid interpolation, which escapes
 * automatically). Keeping presentation out of the parser removes a whole class
 * of injection bug: a crafted snapshot cannot smuggle markup through a variable
 * name or program line, because nothing here concatenates into an HTML string.
 */

/** One detokenised program line. `text` is plain, unescaped BASIC source. */
export interface BasicListingLine {
  lineNumber: number;
  /** Detokenised line body, exactly as it should read — no HTML entities. */
  text: string;
}

/** One entry in the BASIC variables area. All string fields are plain text. */
export interface BasicVariable {
  /** Name as displayed: `a`, `a$`, `count`, `a(3,4)`, `s$(2,10)`. */
  name: string;
  kind: 'number' | 'string' | 'array' | 'for-next';
  /** Displayed value: a number, the raw string content (no surrounding quotes
   *  — the renderer adds them), or a FOR variable's current value. Omitted for
   *  arrays. */
  value?: string;
  /** Muted trailing detail — a FOR loop's `TO … STEP …`. Omitted otherwise. */
  detail?: string;
}
