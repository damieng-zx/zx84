/**
 * PcwConfig — per-model capability object for the PCW family.
 *
 * The PCW analogue of `CpcConfig` / `SamConfig`: one place that answers "what
 * is fitted", so the memory, the drives and the printer never have to ask which
 * model they are on.
 */

import type { PcwModel } from './models.ts';
import {
  pcwBlocks, pcwDefaultPhosphor, pcwDriveCount, pcwHasDoubleSidedDriveA, pcwPrinter,
} from './models.ts';
import { PCW_BLOCK_SIZE } from './constants.ts';

export interface PcwConfig {
  readonly model: PcwModel;
  /** Fitted 16K blocks (16 = 256K, 32 = 512K). */
  readonly blocks: number;
  /** Floppy drives fitted (1 or 2). */
  readonly drives: number;
  /** Drive A is the 720K double-sided mechanism rather than the 180K one. */
  readonly doubleSidedA: boolean;
  readonly printer: 'matrix' | 'daisywheel';
  readonly phosphor: 'green' | 'white';
  /** Human-readable memory size (UI / status). */
  readonly ramLabel: string;
}

export function createPcwConfig(model: PcwModel): PcwConfig {
  const blocks = pcwBlocks(model);
  return {
    model,
    blocks,
    drives: pcwDriveCount(model),
    doubleSidedA: pcwHasDoubleSidedDriveA(model),
    printer: pcwPrinter(model),
    phosphor: pcwDefaultPhosphor(model),
    ramLabel: `${(blocks * PCW_BLOCK_SIZE) / 1024}K`,
  };
}
