import type { MachineModel } from '../src/models.ts';
import { registry } from '../src/machines/registry.ts';
import { legacySpectrumModel } from '../src/models.ts';

/** Models exposed by the MCP, derived from the machine registry so a newly
 * registered family is not silently omitted from the headless interface. */
export const MCP_MODELS = registry.flatMap(entry => entry.models) as [MachineModel, ...MachineModel[]];

export function isMcpModel(value: string): value is MachineModel {
  return (MCP_MODELS as readonly string[]).includes(value);
}

/** A model id as given on the command line: a current id, or one of the
 *  Spectrum's old ids (`48k`, `+2A`, …) so existing `--model` configs keep
 *  starting the machine they name instead of silently falling back. */
export function resolveMcpModel(value: string): MachineModel | null {
  return isMcpModel(value) ? value : legacySpectrumModel(value);
}
