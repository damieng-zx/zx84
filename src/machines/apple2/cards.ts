/**
 * Expansion cards.
 *
 * A card in slot N answers three parts of the address space:
 *
 *  - `$C0N0-$C0NF` — its device I/O, sixteen registers (N is the slot plus 8);
 *  - `$CN00-$CNFF` — its own page of ROM, which the motherboard serves from the
 *    slot ROM image unless the card claims the access itself (the Mockingboard
 *    puts its chips there);
 *  - `$C800-$CFFF` — the shared expansion area, which a card owns from the moment
 *    its `$CN00` page is touched until `$CFFF` is accessed.
 *
 * Cards that need none of these simply leave the hooks out.
 */

export interface Apple2Card {
  /** Slot the card is plugged into (1-7). */
  readonly slot: number;

  /** Device I/O register `reg` (0-15). */
  ioRead?(reg: number): number;
  ioWrite?(reg: number, val: number): void;

  /** Byte `offset` (0-255) of the card's `$CNxx` page; -1 to serve its ROM image. */
  pageRead?(offset: number): number;
  pageWrite?(offset: number, val: number): void;

  /** The card has expansion ROM/RAM at `$C800-$CFFF`; byte `offset` (0-$7FF).
   *  -1 from `expansionRead` means nothing answers there. */
  readonly hasExpansion?: boolean;
  expansionRead?(offset: number): number;
  expansionWrite?(offset: number, val: number): void;

  /** Machine reset. */
  reset?(): void;
}
