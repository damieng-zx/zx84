// Public entry point for the Z80 CPU core.
//
// Importing this module attaches all instruction methods (ALU, rotates, opcode
// dispatcher, and CB/ED/DD/FD prefix decoders) to Z80.prototype via side
// effects. Always import the class from here (or from `@/cores/z80.ts`,
// which re-exports from this file) — never from `./core.ts` directly, or the
// prototype will be missing methods at runtime.
import { Z80 } from './core.ts';
import './alu.ts';
import './rotate.ts';
import './exec-main.ts';
import './exec-cb.ts';
import './exec-ed.ts';
import './exec-index.ts';

export { Z80 };
