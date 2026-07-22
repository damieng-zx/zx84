import type { MachineModel } from '../src/models.ts';
import { registry } from '../src/machines/registry.ts';

/** Models exposed by the MCP, derived from the machine registry so a newly
 * registered family is not silently omitted from the headless interface. */
export const MCP_MODELS = registry.flatMap(entry => entry.models) as [MachineModel, ...MachineModel[]];

export function isMcpModel(value: string): value is MachineModel {
  return (MCP_MODELS as readonly string[]).includes(value);
}
