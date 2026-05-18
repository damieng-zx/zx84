import type { Spectrum } from '../src/spectrum.ts';

const FDC_LOG_MAX = 2000;
export const fdcLog: string[] = [];

export function wireFdcLog(spec: Spectrum): void {
  spec.fdc.logFn = (...args: unknown[]) => {
    const line = args.map(a => String(a)).join(' ');
    fdcLog.push(line);
    if (fdcLog.length > FDC_LOG_MAX) fdcLog.shift();
  };
}
