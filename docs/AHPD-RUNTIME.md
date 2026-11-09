# Prepare the pinned external Linux runtime

Historical AHP-only instructions: the current source no longer uses AHPD. Use
[Agent configuration](AGENT-CONFIG.md) for direct ACP. These commands apply only
to the older AHP package and its recorded acceptance, not the new entry.

AHPlex does not install AHPD, ACP or Copilot. Follow the
source-to-local-tarballs commands in the
[README quickstart](../README.md#prepare-an-external-runtime-then-initialize-locally).
The README ships in the npm package; this repository document does not.

Use the exact source commit `1d52d06c65ec1006d548bad7c477e032b9dc6782` from the
[validated AHPD fork](https://github.com/shazhou-ww/ahpd/commit/1d52d06c65ec1006d548bad7c477e032b9dc6782).
It includes both stable restart Session and caller Turn identity fixes. Build
and pack SDK, ACP and server together with the source lockfile, then install
those three explicit local tarballs into one dedicated prefix. Do not install
floating registry `@ahpd/*` packages instead: the release number alone does not
prove these fixes are present. No npm publish command is needed. Copilot CLI is
separately pinned to `@github/copilot@1.0.106`.

Prerequisites: Linux, Node.js 22.18+ (AHPD server's minimum), pnpm 11.22+, npm,
Git, and util-linux's `/usr/bin/script` for native device login. Package-manager
installation/build scripts run as the operator: inspect and trust the source,
keep the deployment root private, and preserve the produced lockfiles and
tarball hashes for reproducible redeployment.

## Private runtime manifest

Use the README's fresh private deployment root and SDK → ACP → server pack
order. In `BASE/runtime/package.json`, the three `file:../artifacts/...`
dependencies select those exact sibling tarballs, not registry AHPD packages:

```json
{
  "name": "ahplex-local-runtime",
  "private": true,
  "type": "module",
  "dependencies": {
    "@ahpd/sdk": "file:../artifacts/ahpd-sdk-0.15.0-rc.1.tgz",
    "@ahpd/server": "file:../artifacts/ahpd-server-0.15.0-rc.1.tgz",
    "@ahpd/agent-acp": "file:../artifacts/ahpd-agent-acp-0.15.0-rc.1.tgz",
    "@microsoft/agent-host-protocol": "1.0.0",
    "zod": "4.5.4"
  },
  "overrides": {
    "@ahpd/sdk": "$@ahpd/sdk"
  }
}
```

Then run `npm install --prefix "$BASE/runtime"` and retain the generated
lockfile. The manifest is private; there is no publication step. The README uses
a new root, restrictive umask and shell noclobber so configuration creation does
not replace existing files.

The narrowly targeted npm override makes server and ACP resolve the explicitly
supplied SDK prerelease. ACP's `>=0.14 <1` peer range otherwise excludes
`0.15.0-rc.1`; installing only the three tarball arguments fails peer
resolution. The `$@ahpd/sdk` reference reuses the direct dependency spec rather
than substituting a registry version or globally disabling peer checks. Keep
protocol `1.0.0` and `zod` `4.5.4` as explicit direct dependencies for this
assembly.

## Installed-prefix contract

`ahplex init --runtime-root PREFIX` checks only these known files, following
normal package-manager symlinks beneath the explicitly selected root:

```text
PREFIX/
  node_modules/@ahpd/
    sdk/dist/index.js
    server/dist/main.js
    agent-acp/package.json
    agent-acp/dist/index.js
```

The generated server command is the current `process.execPath` plus the absolute
`server/dist/main.js`; `--node-command` can choose another native Node. The
plugin is the absolute `agent-acp` package directory. `--copilot-command` must
select the native executable explicitly (for example
`COPILOT_PREFIX/node_modules/.bin/copilot`), not a shell command string or
`.cmd`/`.bat` shim. `init` checks executable access but never executes any
runtime, reads package metadata/profile contents, or verifies a binary version.
`runtimeRevision` is an operator provenance assertion, not an integrity check.

Check `npm --prefix PREFIX ls @ahpd/sdk @ahpd/server @ahpd/agent-acp` and
confirm both server and ACP resolve the supplied top-level SDK. For example, on
Linux:

```bash
ROOT="$HOME/ahplex-local/runtime" node --input-type=module -e '
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
const root = process.env.ROOT + "/node_modules/@ahpd/";
const expected = realpathSync(root + "sdk/dist/index.js");
for (const name of ["server", "agent-acp"]) {
  const resolved = createRequire(root + name + "/package.json").resolve("@ahpd/sdk");
  if (realpathSync(resolved) !== expected) throw new Error("SDK mismatch: " + name);
}
'
```

This checks resolution, not patched source bytes. Verify the source revision
before packing and retain hashes from that build. Do not mix a fresh server with
an old SDK/ACP tarball or assume the latest published packages contain the
accepted fixes.

## Deliberate trust and login

The workspace passed to `--workspace` must exist and becomes the sole static
trusted and served directory. This is a trust grant, not sandboxing.
`sessions:file`, `--no-cwd` and `hostTools:false` are enforced by the existing
adapter. No API caller can enlarge trust by supplying a new workdir.

`init` creates only the configuration file, with exclusive creation and mode
0600 on Linux. It does not create missing parent, data or profile directories.
Provision private parent directories yourself. Choose distinct API/daemon ports,
service data and profile roots; file checks do not reserve ports or lock an
external profile.

For fresh login, use the generated dedicated profile and expected
`--login-account`. Start the service separately, explicitly request
`native-login` and poll `auth get`. The device flow requires explicit
`confirmPlaintextStorage: "yes"` if requested; no storage decision is automatic.
For reuse, explicitly select an authorized profile with `--copilot-profile` and
request `reuse-native-login`. No credential discovery, copying, or paid probe
occurs. Reuse can remain `auth_verification_unsupported` until a
caller-requested genuine completed Turn establishes current-generation evidence.

See [native authentication](HOST-CONFIG.md#native-copilot-authentication). OAuth
evidence is not a Copilot entitlement or billing-account guarantee.
