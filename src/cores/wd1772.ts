/**
 * WD1772 Floppy Disk Controller — used by the MGT +D interface.
 *
 * The 1770/1772 have no READY line: status bit 7 is the MOTOR ON line, and a
 * WRITE TRACK lays down the +D's 10 × 512-byte G+DOS track. Both of those are
 * the WD179x base class's defaults, so this subclass is behaviour-identical to
 * the base — it exists to name the +D's controller and to sit alongside the
 * WD1793 (see wd1793.ts) as a peer subclass.
 */

import { WD179x } from '@/cores/wd179x.ts';

export class WD1772 extends WD179x {}
