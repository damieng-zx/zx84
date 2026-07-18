/**
 * ZX84 architecture boundary rules (dependency-cruiser).
 *
 * See docs/re-architecture.md §3.1 (import table) and §7 (enforcement).
 *
 * Phase 1 of the migration has relocated the code into the target layered
 * layout, so these rules now run against the real folders:
 *
 *   - src/cores/       commodity silicon; imports only cores + media types + utils.
 *   - src/media/       format/codec code; imports only media + utils (pure data).
 *   - src/machines/<name>/  one machine per folder; an island that may reach its
 *                      own folder, the shared machine substrate
 *                      (machine.ts / base-machine.ts / registry / shared),
 *                      cores, media, debug substrate (src/debug) and utils — but
 *                      never another machine folder, and never UI / reactive
 *                      state / settings store.
 *   - src/debug/       machine-agnostic debug tools + CPU-family debug substrate
 *                      (src/debug/<family>/); imports cores, utils, and the
 *                      machine SPI *types* only.
 *
 * All four rules currently pass with ZERO exceptions — the Phase 0 baseline
 * backlog (cores/ula.ts → keyboard.ts, cores/gate-array.ts → cpc/constants.ts)
 * was cleared by moving that custom silicon into its machine folder.
 *
 * Note: a `ui-no-concrete-machines` rule (§7) is intentionally NOT enforced yet
 * — UI panes still import concrete machines until Phase 6. It is added when the
 * shell/service seams land.
 */

module.exports = {
  forbidden: [
    {
      name: 'cores-know-nothing',
      comment:
        'src/cores/** models commodity silicon: it may import only other cores, ' +
        'media types (src/media), and src/utils. See re-architecture §3.1.',
      severity: 'error',
      from: { path: '^src/cores/' },
      to: {
        pathNot: '^(src/cores/|src/media/|src/utils/|node_modules/)',
      },
    },
    {
      name: 'media-is-pure',
      comment:
        'Format/media code (src/media) parses into neutral models and must not ' +
        'import a machine, core, UI, or state — only other media and utils. §3.1/§4.',
      severity: 'error',
      from: { path: '^src/media/' },
      to: {
        pathNot: '^(src/media/|src/utils/|node_modules/)',
      },
    },
    {
      name: 'machines-are-islands',
      comment:
        'A machine folder (src/machines/<name>/) is an island: it may import its ' +
        'own folder plus the shared substrate (machine.ts, base-machine.ts, ' +
        'registry, shared/), but never another machine folder. §3.1.',
      severity: 'error',
      from: { path: '^src/machines/([^/]+)/' },
      to: {
        path: '^src/machines/(?!$1/|machine|base-machine|registry|shared)',
      },
    },
    {
      name: 'debug-is-cpu-substrate',
      comment:
        'src/debug holds machine-agnostic debug tools and CPU-family debug ' +
        'substrate (src/debug/<family>/: disassembler + DebugService provider). ' +
        'It may import cores, utils, and the machine SPI *types* (machine.ts) — ' +
        'never a concrete machine folder, UI, state, store, or shell.',
      severity: 'error',
      from: { path: '^src/debug/' },
      to: {
        pathNot: '^(src/debug/|src/cores/|src/utils/|src/machines/machine\\.ts$|node_modules/)',
      },
    },
    {
      name: 'machines-no-ui',
      comment:
        'A machine folder must not import UI, reactive state, the settings store, ' +
        'the shell, or solid-js; those bind to machines through services/registry, ' +
        'not vice-versa. §3.1.\n' +
        'EXCEPTION: a machine`s own `ui/` subfolder holds its Solid UI contributions ' +
        '(hardware-pane section, on-screen keyboard, sysvars) — the only machine files ' +
        'allowed to import solid-js and the shell/state/store they bind to. They are ' +
        'still islands (machines-are-islands forbids importing another machine).',
      severity: 'error',
      from: { path: '^src/machines/', pathNot: '^src/machines/[^/]+/ui/' },
      to: { path: '^(src/ui/|src/state/|src/store/|src/shell/|solid-js)' },
    },
    {
      name: 'ui-no-concrete-machines',
      comment:
        'Generic UI (src/ui) and reactive state (src/state) must not import a ' +
        'concrete machine folder (src/machines/<name>/). They bind to machines through ' +
        'the SPI (machine.ts), the registry, the descriptor`s `ui` capabilities, and ' +
        'services. §3.1/§7.\n' +
        'The SOLE sanctioned exception is the UI-side manifest ' +
        '`src/ui/machine-ui.ts`, which lazily maps a machine kind to its `ui/` ' +
        'contributions. The shell is governed separately by `shell-stays-above-machines`.',
      severity: 'error',
      from: { path: '^src/(ui|state)/', pathNot: '^src/ui/machine-ui\\.ts$' },
      to: { path: '^src/machines/[^/]+/' },
    },
    {
      name: 'shell-stays-above-machines',
      comment:
        'The shell (src/shell) may import the machine SPI + registry (machine.ts, ' +
        'registry.ts), state, store, media, and display — but NOT a concrete machine ' +
        'folder. It reaches machines through the SPI/services only. §3.1/§7.\n' +
        'Phase 8 dissolved the last two carve-outs: the shell-context `spectrum` ' +
        'narrowing shim (HMR/boot-trap/IF1-format now go through services + narrow ' +
        'SPI hooks) and the direct SZX import (now SnapshotService.saveSync/' +
        'restoreSync). ZERO exceptions remain — the boundary is a hard error.',
      severity: 'error',
      from: { path: '^src/shell/' },
      to: {
        path: '^src/machines/[^/]+/',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
