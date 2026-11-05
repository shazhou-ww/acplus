# Project Guidelines

## Development

- This preset builds a single ESM TypeScript package for npm. Keep public
  exports in `src/index.ts`, tests in `test/`, and generated files in `dist/`.
- Use Node.js 22.13 or newer and pnpm 11.22 or newer.
- Install dependencies with `pnpm install`.
- Run `pnpm check` before submitting changes; it includes package-shape
  validation through `pnpm lint:package`.
- Preserve the package `exports` map and `files` allowlist when changing the
  build or package metadata.

## Skills

- Manage project skills with `npx skills`.
- Keep all project skills under `.agent/skills/<skill-name>/`, with each skill's
  `SKILL.md` in its directory.

## Publishing

- Keep the package private until its metadata and release setup are
  intentionally configured for publication.
- Follow the Trusted Publishing workflow in `README.md`; do not introduce
  long-lived npm tokens.
- Publish only by pushing an explicitly approved `v<package.version>` release
  tag to trigger `.github/workflows/publish-npm.yaml` with GitHub Actions OIDC.
- Never run `npm publish` locally, including `--dry-run`. Corporate network
  policy restricts local npm publishing; do not work around it with another
  shell, runtime, proxy, or registry.
- Run publishing diagnostics and npm registry/package verification in GitHub
  Actions. Use `gh workflow run publish-npm.yaml --ref main` for a nonpublishing
  diagnostic, or add `-f verify-version=<version>` to verify an existing release
  without publishing it again.
- Inspect the actual registry/install result after a failed or cancelled run;
  cancellation is not proof that publishing did not happen. Never move or reuse
  a pushed release tag or overwrite a published version.
