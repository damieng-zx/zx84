import type { Machine } from '../src/machines/machine.ts';

const FDC_LOG_MAX = 2000;
export const fdcLog: string[] = [];

export function wireFdcLog(spec: Machine): void {
  // Every machine carries a concrete `fdc` field (the MSX's is an unwired
  // stub); structural access here mirrors the old shared surface, MCP-side.
  const fdc = (spec as unknown as { fdc?: { logFn: ((...args: unknown[]) => void) | null } }).fdc;
  if (!fdc) return;
  fdc.logFn = (...args: unknown[]) => {
    const line = args.map(a => String(a)).join(' ');
    fdcLog.push(line);
    if (fdcLog.length > FDC_LOG_MAX) fdcLog.shift();
  };
}
