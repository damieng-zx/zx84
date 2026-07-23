# Releasing ZX84

Production is **tag-driven**. Cloudflare no longer auto-deploys `main`; instead,
pushing a `vX.Y.Z` git tag triggers the [`Deploy to Cloudflare`](.github/workflows/deploy.yml)
GitHub Action, which builds that exact commit and runs `wrangler deploy`. **The
most recently pushed release tag is what Cloudflare serves.**

`main` is a pure integration branch — merges to it never touch production.

## Cutting a release

The app version lives in **two** places that must stay in sync:

1. **`package.json`** — the `version` field (single source injected into the app as
   `__APP_VERSION__` via `vite.config.ts`, rendered as the version superscript).
2. **`src/ui/panes/ChangelogPane.tsx`** — the top entry of the hand-maintained
   `CHANGELOG` array. This one does *not* derive from `package.json`, so it silently
   drifts if you forget it.

Steps:

1. Bump `version` in `package.json` (e.g. `0.7.3` → `0.7.4`).
2. Add the matching new entry at the top of the `CHANGELOG` array in
   `src/ui/panes/ChangelogPane.tsx`.
3. Verify locally: `npx vitest run` (green) and `npx tsc --noEmit` (clean).
4. Commit both files (`git commit -F <tempfile>`).
5. Tag and push:
   ```sh
   git tag v0.7.4
   git push && git push --tags
   ```
6. Watch the **Actions** tab — the `Deploy to Cloudflare` run publishes production.
   Confirm the live version superscript and changelog match the release.

Version numbers follow the existing `MAJOR.MINOR.PATCH` scheme.

## Not part of a release

The library **catalog** (R2) is deployed separately and only when catalog data
changes — it is unaffected by app releases:

```sh
npm run deploy:catalog
```
