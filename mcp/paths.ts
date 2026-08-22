/**
 * Filesystem confinement for MCP tool I/O.
 *
 * The MCP server runs as a persistent local process with the user's full
 * permissions. Tools that take caller-supplied paths — screenshot/save
 * outputs, symbols_load input — must not become arbitrary filesystem
 * access: every path is resolved (collapsing `..` traversal) and checked
 * against the permitted roots: the MCP cache directory and the working
 * directory the server was launched from (the workspace under test).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { CACHE_DIR } from './rom-fetch.ts';

export const ALLOWED_ROOTS: readonly string[] = [CACHE_DIR, path.resolve(process.cwd())];

/** Windows paths are caseless; compare accordingly. */
function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** Resolve `p` and verify it stays under an allowed root.
 *  Returns null when the path is permitted, else a rejection message. */
export function checkPathAllowed(p: string): string | null {
  const resolved = path.resolve(p);
  const ok = ALLOWED_ROOTS.some(
    root => norm(resolved) === norm(root) || norm(resolved).startsWith(norm(root) + path.sep),
  );
  if (ok) return null;
  return `Refusing to access ${resolved}: outside the permitted roots (${ALLOWED_ROOTS.join(', ')}). Outputs must be written under the MCP cache or the server's working directory; inputs must be read from the same.`;
}

export interface BoundedRead {
  text?: string;
  error?: string;
}

/** Read a UTF-8 text file with a size cap, so a mis-pointed path cannot
 *  drag an arbitrarily large file into memory. Callers pre-check existence. */
export function readTextBounded(p: string, maxBytes: number): BoundedRead {
  const st = fs.statSync(p);
  if (st.size > maxBytes) {
    return { error: `File too large: ${p} is ${st.size} bytes (limit ${maxBytes}).` };
  }
  return { text: fs.readFileSync(p, 'utf8') };
}
