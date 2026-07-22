import type { Machine } from '../src/machines/machine.ts';
import { fdcLogSink } from './concrete.ts';

const FDC_LOG_MAX = 2000;
export const fdcLog: string[] = [];

export function wireFdcLog(spec: Machine): void {
  const fdc = fdcLogSink(spec);
  if (!fdc) return;
  fdc.logFn = (...args: unknown[]) => {
    const line = args.map(a => String(a)).join(' ');
    fdcLog.push(line);
    if (fdcLog.length > FDC_LOG_MAX) fdcLog.shift();
  };
}
