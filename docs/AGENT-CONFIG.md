# Static ACP Agent configuration

Use configuration `schemaVersion: 2`. No legacy `hosts` registry, AHPD runtime,
VS Code launcher, attach mode, arbitrary HTTP command registration, or automatic
credential/configuration migration is supported.

Configuration files use YAML. `acplus init` defaults to `~/.acplus/acplus.yaml`,
creating the default parent directory privately. The default data directory is
`~/.acplus/state` and default Copilot profile is `~/.acplus/copilot-profile`,
independently of a `--data-dir` override. `acplus serve` reads that fixed config
path when `--config` is omitted. It does not search the working directory or
migrate old files. On Windows, `~` means the home directory returned by Node's
`os.homedir()`. Explicit relative CLI paths resolve from the invoking directory;
custom config parents must already exist. `--config -` reads one YAML document
from stdin. JSON syntax is accepted as a YAML subset, but `init` always writes
YAML. Duplicate keys, multiple documents, unknown tags and excessive aliases are
rejected. HTTP request and response formats remain JSON.

Each Agent uses an explicit native executable and argument array, dedicated
profile, allowed workspace roots, and optional configured MCP servers. Relative
data/profile/workspace/secret-file paths resolve from the config file; stdin
configuration resolves from the invoking directory. Executables must be absolute
native paths, not `.cmd`/`.bat` shims.

```yaml
schemaVersion: 2
instance: local
dataDir: ./state
listen:
  host: 127.0.0.1
  port: 4280
agents:
  - id: copilot
    label: Copilot CLI
    command: /usr/local/bin/copilot
    args: ["--acp"]
    profileDir: ./copilot-profile
    workspaces: ["/srv/work/project"]
    permission: deny
    idleTimeoutMs: 0
    authentication:
      type: copilot
      loginAccount: YOUR-LOGIN
```

Replace the executable, existing workspace and expected account explicitly.
Setting paths is not evidence of login. Service startup creates private storage
and explicit profile directories, but never launches an Agent merely to inspect
them. Session creation and GETs are local-only.

| Field                         | Default / rule                                               |
| ----------------------------- | ------------------------------------------------------------ |
| `instance`                    | `local`                                                      |
| `listen.host` / `listen.port` | loopback / 4280; port 0 requests an ephemeral port           |
| `agents[].args`               | `["--acp"]`; choose actual Agent flags explicitly            |
| `agents[].env`                | empty; minimal OS environment plus explicit overrides        |
| `agents[].mcpServers`         | empty; configured stdio or advertised HTTP/SSE support       |
| `agents[].startupTimeoutMs`   | 30,000; bounded range 100–300,000                            |
| `agents[].idleTimeoutMs`      | 0, disabled; otherwise only known idle work permits exit     |
| `agents[].permission`         | `deny`; `allow` chooses only supported one-call approval     |
| `agents[].authentication`     | optional; Copilot native device flow requires expected login |

Agent IDs and canonical profile directories must be distinct. Runtime profile
leases also reject cooperating instances sharing an active profile across data
roots. No stale lock is silently deleted. After an unclean exit, verify owned
process cleanup before explicitly repairing ownership.

The profile coordination file retains its established `.ahplex-acp-owner.lock`
name so already-running v2 runtimes and renamed acplus instances cannot
simultaneously own the same profile. This is an ownership safety boundary, not
an old HTTP/CLI compatibility layer.

Credentials remain in Agent profiles/stores or explicit references:

```yaml
env:
  PROVIDER_API_KEY:
    source: env
    name: MY_PROVIDER_API_KEY
  OTHER_API_KEY:
    source: file
    path: /private/provider-key
```

References are resolved only from the specified source; missing credentials fail
explicitly. Do not embed real keys in source/config examples or command
arguments. Known referenced/literal credential-like values are redacted before
content persistence. This cannot identify every secret in arbitrary Agent
output; private data must be access-controlled and backups protected.

The initial client advertises no filesystem or terminal callbacks it does not
implement. Agents may use their own tools and request explicit permission. The
deny default is not an OS sandbox, and `allow` is a deliberate trust grant.
Configure a dedicated OS account/container for untrusted tools and keep
credential profiles/data roots outside the trusted Agent workspace.

Configuration does not choose arbitrary model/provider settings per request.
Operator-supplied environment and the Agent's own profile manage those choices.
Support for other ACP Agents requires separate initialization/auth/tool/restart
acceptance; a successful Copilot test is not proof of universal Agent support.
