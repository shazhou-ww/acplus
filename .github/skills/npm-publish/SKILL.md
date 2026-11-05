---
name: npm-publish
description:
  "Use when: releasing or publishing this package to npm, choosing or bumping
  its version, creating an npm release tag, monitoring the tag-triggered publish
  workflow, or diagnosing a failed npm release."
argument-hint: "<stable-semver-version>"
---

# Publish this package to npm

Release the package through `.github/workflows/publish-npm.yaml`. A pushed
`v<package.version>` tag is the only normal publishing mechanism.

## Release invariants

- Use the official registry, `https://registry.npmjs.org/`.
- Run all npm publishing, including dry runs, and registry/package verification
  in GitHub Actions. Never run `npm publish` locally or bypass corporate network
  restrictions with another runtime, proxy, or registry.
- Publish with GitHub Actions OIDC Trusted Publishing. Never create, request,
  print, store, or use an `NPM_TOKEN`, and never request an OTP.
- Accept stable SemVer releases only: `X.Y.Z` and tag `vX.Y.Z`.
- The tag must exactly match `package.json` and point to a commit reachable from
  `origin/main`.
- Never move, reuse, force-push, or silently delete a release tag.
- Never attempt to overwrite an npm version; registry versions are immutable.
- Run the complete repository checks before any release push.
- Treat a direct request to publish or release a specific version as approval to
  push the prepared `main` commit and its matching tag. Otherwise, ask for
  explicit confirmation before either push.

## One-time Trusted Publisher setup

The package must already exist on npm. In its npmjs.com package settings, add a
GitHub Actions Trusted Publisher with:

- organization or user: the GitHub repository owner
- repository: the GitHub repository name
- workflow filename: `publish-npm.yaml`
- environment: `npm`
- allow npm publish: enabled
- allow npm dist-tag: enabled

Create the `npm` environment in the GitHub repository. Do not add an npm token
to GitHub Secrets. A new Trusted Publisher connection must complete its first
successful publish within two days or npm expires it. The workflow pins npm
11.21.0 because OIDC dist-tag management requires npm 11.21.0 or later on the
npm 11 release line.

Validate a new or changed connection without publishing:

```sh
gh workflow run publish-npm.yaml --ref main
```

The manual run substitutes a unique temporary version and executes
`npm publish --dry-run` with verbose OIDC diagnostics. It never publishes a
package or changes a dist-tag.

After one OIDC release succeeds, set npm package **Publishing access** to
**Require two-factor authentication and disallow tokens**. This does not disable
Trusted Publishing.

## Prepare a release

1. Inspect all state before changing it:

   ```sh
   git status --short --branch
   git fetch origin main --tags
   git log --oneline --decorate -10
   node -p "require('./package.json').name"
   ```

2. Require a clean worktree and local `main` synchronized with `origin/main`.
   Preserve unrelated changes. Do not release from another branch.

3. Determine the version:
   - Use the version explicitly requested by the user.
   - If no version was supplied, ask the user to choose the stable SemVer
     version. Do not infer a major-version change.
   - Confirm version availability through GitHub Actions registry inspection.
     The tag workflow also rejects already published versions. Never infer
     package absence from a network or TLS failure.

4. Update the manifest without creating a tag:

   ```sh
   pnpm version <version> --no-git-tag-version
   ```

5. Update directly related release documentation when behavior or requirements
   changed. Do not add speculative release notes.

6. Validate the exact candidate:

   ```sh
   pnpm check
   ```

   Synchronize the candidate to `main`, then trigger the nonpublishing Actions
   diagnostic with `gh workflow run publish-npm.yaml --ref main`. Inspect its
   dry-run logs before pushing a release tag. Confirm the expected name, entry
   points, files, and absence of npm manifest auto-correction warnings. Do not
   substitute a local dry run.

7. Commit the version and related release changes using the repository's commit
   convention. Do not amend unless the user explicitly requests it.

## Push and publish

1. Push `main` normally, without force:

   ```sh
   git push origin main
   ```

2. Confirm the release commit is the refreshed `origin/main` tip.

3. Create and push one annotated tag:

   ```sh
   git tag -a v<version> -m "release: v<version>"
   git push origin refs/tags/v<version>
   ```

4. Find and watch the matching workflow run:

   ```sh
   gh run list --workflow publish-npm.yaml --limit 10
   gh run watch <run-id> --exit-status
   ```

   Use `gh run view <run-id> --log-failed` when it fails.

## Verify the published package

Registry propagation can take a short time. Do not repeat publishing while
waiting. Trigger the verification-only GitHub Actions job:

```sh
gh workflow run publish-npm.yaml --ref main -f verify-version=<version>
gh run list --workflow publish-npm.yaml --limit 10
gh run watch <verification-run-id> --exit-status
```

Confirm that:

- `latest` points to the released stable version;
- entry points and binaries match `package.json`;
- a package-specific import or CLI smoke test succeeds;
- the GitHub Actions run succeeded;
- npm displays provenance for the release.

Report the commit, tag, workflow run, npm version, checks, and any remaining
manual configuration. Do not claim success from the workflow alone.

## Failure handling

- `ENEEDAUTH` or OIDC authentication failures: verify the case-sensitive npm
  Trusted Publisher fields, exact `publish-npm.yaml` filename, GitHub-hosted
  runner, `npm` environment, **Allow npm publish**, **Allow npm dist-tag**, and
  `id-token: write`. Do not fall back to a token or OTP. Run the manual dry-run
  diagnostic after correcting the connection.
- Existing npm version: stop. Never republish it.
- Tag/version mismatch or tag not on `main`: fix the release preparation and
  create a new version. Never move the pushed tag.
- Failure after a tag push: inspect the run first. If npm already has the
  version, verify it rather than retrying. If it does not, fix the cause and
  release a new patch version; do not reuse the failed tag.
- Cancelled runs may already have published. Inspect publish-step logs and run
  verification-only Actions before proposing another release.
- Never delete a remote release tag without explicit user approval.
