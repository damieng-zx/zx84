// Z80 CPU core — split across `./z80/` for maintainability. This shim
// preserves the canonical `@/cores/z80.ts` import path for all 23+ consumers
// across src/ and tests/.
export { Z80 } from './z80/index.ts';
