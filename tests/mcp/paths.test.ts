/**
 * mcp/paths.ts — filesystem confinement for MCP tool I/O.
 *
 * screenshot/save write caller-supplied output paths and symbols_load
 * reads a caller-supplied input path. The server runs with the user's
 * full permissions, so those paths must be confined to the MCP cache
 * and the server's working directory, and text reads must be size-
 * bounded.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ALLOWED_ROOTS, checkPathAllowed, readTextBounded } from '../../mcp/paths.ts';

const CACHE = ALLOWED_ROOTS[0]!;
const CWD = ALLOWED_ROOTS[1]!;

// Scratch dir under the cache root (gitignored) for bounded-read tests.
const SCRATCH = path.join(CACHE, 'paths-test');
fs.mkdirSync(SCRATCH, { recursive: true });
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

describe('checkPathAllowed', () => {
  it('allows paths inside the MCP cache and the working directory', () => {
    expect(checkPathAllowed(path.join(CACHE, 'screenshot.png'))).toBeNull();
    expect(checkPathAllowed(path.join(CWD, 'out', 'snap.szx'))).toBeNull();
  });

  it('allows the roots themselves', () => {
    expect(checkPathAllowed(CACHE)).toBeNull();
    expect(checkPathAllowed(CWD)).toBeNull();
  });

  it('rejects paths outside every root', () => {
    const outside = path.resolve(os.tmpdir(), 'elsewhere', 'x.png');
    const r = checkPathAllowed(outside);
    expect(r).not.toBeNull();
    expect(r).toContain('Refusing');
  });

  it('rejects sibling directories that merely share a string prefix', () => {
    // The cache root sits inside the workspace, so exercise the separator
    // rule against the CWD root: "zx84-evil" must not pass as "zx84\...".
    const sibling = path.dirname(CWD) + path.sep + path.basename(CWD) + '-evil';
    expect(checkPathAllowed(sibling)).not.toBeNull();
  });

  it('rejects traversal that resolves outside the roots', () => {
    expect(checkPathAllowed(path.resolve(CWD, '..', 'escaped.png'))).not.toBeNull();
    expect(checkPathAllowed(path.join(CACHE, '..', '..', '..', 'escaped.png'))).not.toBeNull();
  });
});

describe('readTextBounded', () => {
  it('reads a file within the cap', () => {
    const p = path.join(SCRATCH, 'small.lst');
    fs.writeFileSync(p, '1 8000 start:');
    const r = readTextBounded(p, 1024);
    expect(r.text).toBe('1 8000 start:');
    expect(r.error).toBeUndefined();
  });

  it('refuses files larger than the cap without reading them', () => {
    const p = path.join(SCRATCH, 'big.lst');
    fs.writeFileSync(p, 'x'.repeat(64));
    const r = readTextBounded(p, 32);
    expect(r.text).toBeUndefined();
    expect(r.error).toContain('File too large');
  });
});
