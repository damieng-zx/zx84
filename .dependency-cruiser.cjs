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
 *                      (machine.ts / base-machine.ts / registry / shared / debug-*),
 *                      cores, media and utils — but never another machine folder,
 *                      and never UI / reactive state / settings store.
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
        'registry, shared/, debug-*), but never another machine folder. §3.1.',
      severity: 'error',
      from: { path: '^src/machines/([^/]+)/' },
      to: {
        path: '^src/machines/(?!$1/|machine|base-machine|registry|shared|debug-)',
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
      to: { path: '^(src/components/|src/state/|src/store/|src/shell/|solid-js)' },
    },
    {
      name: 'ui-no-concrete-machines',
      comment:
        'Generic UI (src/components) and reactive state (src/state) must not import a ' +
        'concrete machine folder (src/machines/<name>/). They bind to machines through ' +
        'the SPI (machine.ts), the registry, the descriptor`s `ui` capabilities, and ' +
        'services. §3.1/§7.\n' +
        'The SOLE sanctioned exception is the UI-side manifest ' +
        '`src/components/machine-ui.ts`, which lazily maps a machine kind to its `ui/` ' +
        'contributions. The shell is governed separately by `shell-stays-above-machines`.',
      severity: 'error',
      from: { path: '^src/(components|state)/', pathNot: '^src/components/machine-ui\\.ts$' },
      to: { path: '^src/machines/[^/]+/' },
    },
    {
      name: 'shell-stays-above-machines',
      comment:
        'The shell (src/shell) may import the machine SPI + registry (machine.ts, ' +
        'registry.ts), state, store, media, and display — but NOT a concrete machine ' +
        "folder. It reaches machines through the SPI/services. §3.1/§7.\n" +
        'Two carve-outs remain for Phase 8+ (each documented at its import site):\n' +
        ' - spectrum/spectrum: TYPE-ONLY — the shell context`s `spectrum` narrowing ' +
        '   shim (TODO(P8): HMR snapshot, library boot traps, IF1 blank-format).\n' +
        ' - spectrum/snapshots/szx: the HMR dev-reload snapshot (a shell-owned dev ' +
        '   convenience with no service seam; candidates: SnapshotService.saveSync).',
      severity: 'error',
      from: { path: '^src/shell/' },
      to: {
        path: '^src/machines/[^/]+/',
        pathNot:
          '^src/machines/(' +
          'spectrum/spectrum|' +
          'spectrum/snapshots/szx' +
          ')\\.ts$',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
  },
};
