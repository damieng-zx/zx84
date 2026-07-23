import * as path from 'node:path';
import type { Machine } from '../src/machines/machine.ts';
import { unzip } from '../src/media/zip.ts';
import { state } from './state.ts';
import { resolveMediaSource } from './media-source.ts';

/** Load a local path or HTTP(S) URL through a machine's media service. */
export async function loadMediaInto(machine: Machine, source: string, target?: string): Promise<string> {
  try {
    const media = await resolveMediaSource(source);
    return mountMediaBytes(machine, media.data, media.filename, undefined, target);
  } catch (error) {
    return (error as Error).message;
  }
}

/** Mount in-memory media, unwrapping a ZIP when it contains exactly one file
 *  accepted by the active machine. `target` is the MediaService's drive hint
 *  ('a'/'b'/'unit:N') when the user picked a drive. */
export async function mountMediaBytes(machine: Machine, source: Uint8Array, sourceName: string, innerFile?: string, target?: string): Promise<string> {
  let data = source;
  let filename = sourceName;
  const accepted = new Set(machine.services.media.accepts().map(type => type.ext.toLowerCase()));

  if (/\.zip$/i.test(filename)) {
    let entries;
    try {
      entries = (await unzip(data)).filter(entry => accepted.has(path.extname(entry.name).toLowerCase()));
    } catch (error) {
      return `ZIP error: ${(error as Error).message}`;
    }
    if (entries.length === 0) {
      return `ZIP has no media loadable by ${machine.model.toUpperCase()} (accepts ${[...accepted].join(', ')})`;
    }
    if (innerFile) {
      const wanted = innerFile.toLowerCase();
      entries = entries.filter(entry => entry.name.toLowerCase() === wanted || path.basename(entry.name).toLowerCase() === wanted);
      if (entries.length === 0) return `ZIP has no compatible file named ${innerFile}`;
    }
    if (entries.length > 1) {
      return `ZIP has multiple files loadable by ${machine.model.toUpperCase()}:\n${entries.map(entry => `  • ${entry.name}`).join('\n')}`;
    }
    data = entries[0].data;
    filename = entries[0].name;
  }

  const result = await machine.services.media.mount(data, filename, target);
  if (result.replay) {
    // The mount rebuilt the machine as another model (cross-model snapshot)
    // via host.requestModel — re-dispatch to the replacement in state.spec,
    // exactly like the shell's reflectMount. The new machine matches the
    // media's model, so the replayed mount cannot recurse.
    return mountMediaBytes(state.spec, data, filename, innerFile, target);
  }
  return result.message;
}
