# ocs — OpenCode Sandbox

Run [OpenCode](https://opencode.ai/) inside an OS-level sandbox, with filesystem and
network policy derived from a per-project config file.

```
ocs ~/Workspace/my-project
```

Under the hood `ocs` compiles a policy and hands it to
[`srt`](https://github.com/anthropic-experimental/sandbox-runtime) (Anthropic's Sandbox
Runtime), which enforces it with **bubblewrap** on Linux and **Seatbelt**
(`sandbox-exec`) on macOS. `ocs` does not implement sandboxing; it implements the
part that is tedious and easy to get wrong: deciding *what* should be allowed, for
*this* project, safely, when one of the config inputs is a Git repository you just
cloned.

The design goal is that running `ocs` on an unfamiliar repository is safe by
default. See [Security model](#security-model).

---

## Status

**Pre-alpha.** This document is the specification. No code is written yet.

---

## Why

An agent run unsandboxed executes as you, with your permissions. It can read your
SSH keys, your cloud credentials, and your other projects; it can exfiltrate all
three; and it does all of this while confidently believing it was being helpful.

Containment options, briefly:

| Approach | Verdict |
| --- | --- |
| VM / micro-VM | Strongest, but the weight is out of proportion to the threat. |
| Container (Docker/Podman) | You either rebuild your whole toolchain in an image or bind-mount your home back in, which is where the isolation went. |
| **bubblewrap / Seatbelt** | No daemon, no image, uses the toolchain you already have. This is the choice. |

For the sandboxing *primitive*, `srt` is the better-maintained and more
configurable option than hand-rolling `bwrap` arguments — it compiles a JSON
allowlist into a bubblewrap profile, routes traffic through domain-filtering
proxies, and gets the awkward parts right (seccomp-based Unix socket blocking, PIN
protections against write-deny path swapping, TLS trust bundling for Go and JVM
clients).

Inspiration: [Sandboxing OpenCode With Bubblewrap and Anthropic's Sandbox
Runtime](https://blog.guillaumea.fr/post/sandboxing-opencode-ai-agents-bubblewrap-srt/).

---

## Install

### Arch Linux

```sh
git clone <this-repo> && cd ocs && makepkg -si
```

The `PKGBUILD` pulls the real dependencies:

| Package | Why |
| --- | --- |
| `bubblewrap` | The Linux sandbox primitive. |
| `socat` | Bridges `srt`'s network proxies into the namespace. **Linux only.** |
| `ripgrep` | Used by `srt` to scan for sensitive files under writable paths. |
| `nodejs` | Runs `ocs` and `srt`. |

It also vendors `@anthropic-ai/sandbox-runtime` at a pinned version so `ocs` never
depends on whatever happens to be in a global npm prefix.

There is deliberately no separate `sandbox-runtime` package to install. As of
writing there is no AUR package and nothing in the official `extra`/`community`
repositories — the only `srt` packages in the AUR are the unrelated Secure Reliable
Transport video codec and the SubRip subtitle format. Vendoring via this `PKGBUILD`
is the intended path, and it means pacman owns the version pin.

### macOS

```sh
npm install -g @anthropic-ai/sandbox-runtime   # provides `srt`
npm install -g ocs
brew install ripgrep
```

### First run

```sh
ocs init
```

Writes `~/.config/ocs/config.json` with a conservative starting policy, and — if it
can — infers which model providers you use by reading your existing
`~/.config/opencode/opencode.json`, so the agent can actually reach its API. It
prints what it inferred; review it. An empty `network.allow` means the agent cannot
call any model, and `ocs` is a very expensive way to type.

---

## Usage

```
ocs [options] [<project-path>] [-- <opencode args...>]
```

`<project-path>` defaults to the current directory. Everything after `--` is passed
through to `opencode`.

| Option | Effect |
| --- | --- |
| `-m, --mount <path>` | Extra read-only bind for this run. Repeatable. |
| `-w, --mount-write <path>` | Extra writable bind for this run. Repeatable. |
| `-n, --domain <domain>` | Add an allowed domain for this run. Repeatable. |
| `-c, --config <path>` | Use an alternate project config file. |
| `--print-config` | Print the compiled `srt` settings and exit. Runs no sandbox. |
| `--explain` | With `--print-config`, annotate each entry with its origin. |
| `--debug` | Pass `SRT_DEBUG=1` through to `srt`. |
| `-y, --yes` | Do not prompt. |
| `-V, --version` / `-h, --help` | |

`-m` and `-n` are the escape hatch: a repository's config can *ask* for extra
access, and only you can grant it. When a project's compiled policy needs a grant
you have not made, `ocs` prints the exact command to re-run with the flag added.

### Inspecting the policy

```sh
ocs ~/Workspace/my-project --print-config --explain
```

`--explain` prints every entry tagged with where it came from — `host` or
`project:my-project` — which is the fastest way to answer "what is this repo
actually asking for?"

---

## Configuration

Two files, merged into one policy.

**Host** — `~/.config/ocs/config.json`. Yours. Fully trusted.

**Project** — `<project-path>/.ocs/config.json`. Lives in the repository. Treat
as hostile input.

`.ocs/` is deliberately not `.opencode/`. That directory belongs to OpenCode, which
reads it for `agents/`, `commands/`, `plugins/`, `skills/`, `tools/` and `themes/`,
and resolves project config from `opencode.json` at the repository root. Writing
into a directory another tool owns means depending on its loader's behaviour for
every subdirectory name it might one day decide to interpret.

### Schema

Both files use the same shape. Not every key is honoured in both places; see the
table below.

```jsonc
{
  "$schema": "https://ocs.dev/schema/ocs.schema.json",

  // Domains the sandboxed agent may reach. Additive.
  "network": {
    "allow": ["api.anthropic.com", "*.github.com"],
    "deny": []
  },

  // Extra filesystem grants, layered on top of ocs' built-in defaults.
  // A "mount" is just a bind: read means visible, write means read-write.
  "mounts": {
    "read": ["/opt/vendor-sdk"],
    "write": []
  },

  // Hard denials. These win over everything above, always.
  "protected": {
    "read": ["**/.env", "**/*.pem", "**/id_rsa*"],
    "write": ["secrets/"]
  },

  // Escape hatches. HOST CONFIG ONLY — a project file setting any of these is a
  // hard error, not a warning. See "Why these are host-only".
  "srt": {
    "allowAllUnixSockets": false,
    "allowLocalBinding": false,
    "allowAppleEvents": false,
    "enableWeakerNestedSandbox": false,
    "enableWeakerNetworkIsolation": false,
    "mandatoryDenySearchDepth": 3
  }
}
```

### Mapping to `srt`

`ocs` compiles the above into `srt`'s schema. Keeping this table in your head is
enough to read a raw policy dump.

| `ocs` | `srt` | Default |
| --- | --- | --- |
| `network.allow` | `network.allowedDomains` | curated set from `ocs init` |
| `network.deny` | `network.deniedDomains` | `[]` |
| `mounts.read` | `filesystem.allowRead` | project dir, opencode dirs, system paths |
| `mounts.write` | `filesystem.allowWrite` | project dir, opencode dirs, `/tmp` |
| `protected.read` | `filesystem.denyRead` | home dir + credential globs |
| `protected.write` | `filesystem.denyWrite` | `[]` |
| `srt.*` | same key | see above |

### Built-in defaults

Applied before either config file, so a project with no config at all is still
confined.

**Reads.** The home directory is denied wholesale, then re-opened for exactly what
is needed:

```
denyRead:  ["~"]
allowRead: [ <project-path>,
             ~/.config/opencode, ~/.local/share/opencode,
             ~/.cache/opencode,    ~/.local/state/opencode,
             /usr, /etc, /bin, /lib, /opt, ... ]
```

A denied directory re-opened by an `allowRead` entry is not *fully* re-opened — only
the named path. `denyRead: ["~"]` plus `allowRead: ["/work"]` gives you `/work` and
nothing else out of your home directory.

The opencode paths are derived from the XDG base directories, not hardcoded, so
`XDG_DATA_HOME` and friends are respected. macOS directory layout differs and is
called out under [Platform notes](#platform-notes).

**Writes.** Project directory, the four opencode directories, and `/tmp`. Nothing
else.

**Protected reads**, on top of the home deny — these stay denied even inside the
project, because `srt` gives a specific deny precedence over a broader allow:

```
**/.env, **/.env.*, **/*.pem, **/*.p12, **/*.key,
**/id_rsa*, **/id_ed25519*, **/.netrc, **/.npmrc, **/.git-credentials,
**/.htpasswd, **/credentials.json, **/service-account*.json
```

`.npmrc` and `.git-credentials` deserve a note: they routinely contain live
registry and Git credentials, and they sit *inside* project directories. If a
project genuinely needs authenticated package installs, that has to be an explicit
host-config grant.

**Network.** Allow-only in `srt`, empty by default. `ocs` seeds a small curated
set so a fresh install works; every entry is host-editable.

### Which keys a project file may set

This is the core of the design, so it is worth stating plainly.

| Key | Project may… |
| --- | --- |
| `network.allow`, `network.deny` | add |
| `mounts.read`, `mounts.write` | add, **subject to containment** |
| `protected.read`, `protected.write` | add (adding a deny only tightens) |
| `srt.*` | **nothing — hard error** |

Lists are **unioned, never subtracted**. A project config cannot remove a host
entry, because there is no syntax for removal and there will not be one.

`ocs` does not merge by loading the host config, patching it, and writing it back —
the project config is parsed into its own structure and merged into a fresh policy,
so a merge bug fails closed rather than inheriting something unintended.

---

## Security model

### Threat

A hostile or compromised agent — the model, a dependency it fetches, a package
install script, an MCP server — running with your UID.

### Non-goals

- Kernel exploits. Out of scope; if that is your concern, the answer is a VM.
- Malicious code that is already installed and trusted on your machine. If it runs
  inside the sandbox, the sandbox protects nothing from it.
- Full MITM inspection of allowed traffic. `srt` filters by domain, not by request.
- Multi-tenant isolation. One user, one machine, one agent session at a time.

### The `srt.*` keys are host-only, and it is not a technicality

Four of those settings do not merely widen the policy — they remove it:

- `allowAppleEvents` — a sandboxed process can launch arbitrary applications with no
  prompt, and those applications run **outside** the sandbox entirely.
- `allowAllUnixSockets` — see below; on Linux this is close to full host control.
- `enableWeakerNestedSandbox` — exists so the sandbox can run inside Docker. It
  weakens isolation to accommodate a weaker environment.
- `enableWeakerNetworkIsolation` — re-opens `trustd` on macOS, a documented
  exfiltration path.

A repository that can set these is not sandboxed. `ocs` treats a project config
containing any `srt` key as a hard error and exits, on the grounds that the right
response to "this repo is trying to disable the sandbox" is to stop, not to warn.

This is also why `ocs` ships no `--insecure` flag. If you need a weaker policy for
one run, edit your host config, where the change is visible in a file you control.

### Path containment

Monotonic merging alone does not make untrusted project config safe. A repo with
`mounts.write: ["/"]` is *adding* an entry, so a naive union accepts it and the
sandbox is now wide open.

Every project-supplied path must therefore resolve to one of:

- inside `<project-path>`, after full `realpath` resolution, or
- inside a directory `ocs` already granted to every project (the opencode
  directories, the ocs runtime directory, `/tmp`).

Anything else is rejected with the offending path and the reason. Symlinks are
resolved *before* the containment check, so a symlink planted inside the project
pointing at `~/.aws` is rejected rather than silently honoured. Paths that do not
exist yet are resolved against the nearest existing ancestor, so a not-yet-created
`build/` cannot smuggle its way out through a nonexistent component.

Paths from `-m`/`-n` on the command line are trusted — you typed them — but are
still resolved to absolute and shown in `--explain`.

### Config tampering

`<project-path>/.ocs/config.json` is inside the writable project directory, so the
agent can edit its own policy file.

This is inert: `ocs` reads and compiles the policy once, at launch, writes the
result to a temp file **outside** the project directory, and `srt` reads it once at
wrap time. Nothing re-reads it during the session. Editing the file mid-session has
no effect on the running sandbox — it takes effect the next time you run `ocs`, from
your own shell, which is a decision you make deliberately.

The temp file holds a compiled policy, not a secret, but it is still written
`0600` outside the project and removed on exit.

### What `srt` already does that we rely on

- **Mandatory write denies.** `.bashrc`, `.zshrc`, `.profile`, `.gitconfig`,
  `.gitmodules`, `.mcp.json`, `.vscode/`, `.idea/`, `.git/hooks/`, `.git/config` are
  unwritable inside the sandbox regardless of `allowWrite`. `.mcp.json` being on
  that list is convenient for us: the agent cannot rewrite its own MCP definitions.
- **PIN protections.** Denied paths and their ancestors are made mountpoints, so
  `rm -rf` on a nested repo leaves the protected files behind and cannot unpin them
  by renaming the directory.
- **Resolved-address checks.** An allowed hostname that resolves to loopback,
  link-local, cloud metadata, or one of your own interface addresses is refused, so
  an allowed name cannot be aimed at a local service.
- **Default-deny network.** No domains means no network at all, enforced by removing
  the network namespace, not by hoping the process reads `HTTP_PROXY`.

### Known weaknesses we accept

- **Allowing `github.com` allows pushing to any repository you have credentials for.**
  Exfiltration through an allowed domain is possible by design.
- **Unix sockets on Linux are all-or-nothing.** `srt` blocks socket creation with a
  seccomp filter, which cannot dereference a path from a syscall argument. The
  per-path `allowUnixSockets` list works on macOS and is silently ignored on Linux,
  where the only lever is `allowAllUnixSockets: true` — which also hands over the
  docker socket, `ssh-agent`, and `gpg-agent`. `ocs` does not enable it in the MVP.
- **Env-var-based proxying.** Programs that ignore `HTTP_PROXY`/`HTTPS_PROXY`/
  `ALL_PROXY` get no network inside the sandbox. They fail closed, which is the
  right way to fail, but it can be confusing. `srt` injects a JVM agent for Java
  clients for exactly this reason.
- **Platform-divergent glob semantics.** See below.

---

## MCP support

The short version of the question in the original draft: **yes, most of them work
with no special handling, and the ones that don't fail in ways worth documenting.**

MCP servers launched by OpenCode are its children, so they are already inside the
sandbox. There is no separate mechanism to build.

What each kind needs:

| Server kind | Needs | Works in MVP? |
| --- | --- | --- |
| Stdio, already installed (`node /path/to/server.js`) | runtime on `PATH`, readable | Yes |
| Stdio via `npx -y` / `uvx` | registry in `network.allow`, package cache in `mounts.write` | Yes, after setup |
| Binding a local port | `srt.allowLocalBinding` | Host config only |
| Talks to docker / `ssh-agent` / `gpg-agent` | `srt.allowAllUnixSockets` | **No** — see below |

The `npx` case is the common surprise. `srt` auto-writes `~/.npm/_logs` for
convenience but **not** `~/.npm/_cacache`, which is where `npx` puts downloaded
packages. If an MCP server fails to start, add the cache:

```jsonc
// ~/.config/ocs/config.json
{ "mounts": { "write": ["~/.npm/_cacache"] } }
```

Anything needing a Unix socket is a deliberate decision, not a convenience. On
Linux, granting the docker socket means granting root-equivalent control of the
machine; there is no narrower option to reach for. `ocs` surfaces this as an
explicit, host-config, loudly-worded opt-in and nothing else.

`srt` also supports wrapping an individual MCP server in its own tighter sandbox —
`.mcp.json` entries can invoke `srt` directly. That is a real per-server
tightening option and is worth a follow-up; see [PLAN.md](PLAN.md).

---

## Platform notes

### Linux

`bwrap` 0.12+ (for correct symlink mount handling). `socat` and `ripgrep` required.
Default-deny network works by removing the network namespace entirely.

If you are on Ubuntu 24.04+ or Debian 12+, check
`kernel.apparmor_restrict_unprivileged_userns`. When set, unprivileged user
namespaces lose capabilities and the sandbox will fail with `Operation not
permitted`. Arch is unaffected.

### macOS

`ripgrep` required; `socat` is not. `sandbox-exec` is deprecated by Apple but
functional — expect this to be the part that breaks eventually.

### Glob portability — read this before writing path rules

`ocs` passes `protected.read` through as `srt` globs, and the two platforms do not
implement them the same way:

| | macOS (Seatbelt globs) | Linux (bubblewrap expansion) |
| --- | --- | --- |
| `**/*.pem` under a readable dir | matched | matched, expanded at wrap time |
| Pattern with a wildcard in its first component (`/**/*.pem`) | matched | **silently skipped** |
| File created *after* launch | matched | **not** covered |
| Symlinks | not descended on `allowRead` | descended for `denyRead` |

A rule that protects a secret on macOS can be a no-op on Linux. `ocs` validates
`protected.*` patterns and **refuses to start** with an error naming any pattern
that is only honoured on one platform, rather than letting you believe you are
protected where you are not. This is a deliberate fail-closed choice.

---

## Development

```sh
npm install
npm test          # unit + golden + adversarial; no sandbox required
npm run test:int  # integration; needs bubblewrap + socat
```

The test suite is mostly about the merge layer, because that is where the security
decisions live. Integration tests that actually invoke `bwrap` are a smaller,
separately-gated set.

## License

MIT.

## Acknowledgements

- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) — the sandbox primitive. `ocs` would not exist without it.
- [bubblewrap](https://github.com/containers/bubblewrap)
- [Guillaumea's writeup](https://blog.guillaumea.fr/post/sandboxing-opencode-ai-agents-bubblewrap-srt/) — the idea, and the reason to expect more of these.