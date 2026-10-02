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

`srt` is consumed as a **library**, not as a subprocess. There is no `srt` binary on
your `PATH` and no second thing to install: `ocs` is the only executable, and the
sandbox version is pinned by `ocs`'s own lockfile. See
[Design notes](#design-notes) for why, and for what that costs.

The design goal is that running `ocs` on an unfamiliar repository is safe by
default. See [Security model](#security-model).

---

## Status

**Pre-alpha.** This document is the specification; the implementation has
outgrown parts of it and the gaps are tracked in [PLAN.md](PLAN.md).

Implemented and tested: the config model, the merge layer with both security
gates, policy compilation, the `SandboxRunner` seam over `srt`, the CLI, and
`ocs doctor`. Linux is the working target; `makepkg -si` and `npm install -g ocs`
both install from this tree. macOS is implemented but **unverified** — see
[Install](#install). Known gaps are listed under [Development](#development).

The defaults are deliberately small — one provider domain, five credential
globs, one anchor — because they were measured down from larger first drafts.
A typical project compiles to 6 `denyRead` entries. See "How relative patterns
are resolved" for what the globs do and do not cover.

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

It vendors `@anthropic-ai/sandbox-runtime` as a pinned library dependency, so `srt`
is installed into `ocs`'s own tree and there is no global `srt` for anything else to
pick up. The pin lives in `package-lock.json` and is enforced by `npm ci`, which the
`PKGBUILD` uses rather than `npm install` — so there is exactly one place the
version is written down.

There is deliberately no separate `sandbox-runtime` package to install. As of
writing there is no AUR package and nothing in the official `extra`/`community`
repositories — the only `srt` packages in the AUR are the unrelated Secure Reliable
Transport video codec and the SubRip subtitle format. Vendoring via this `PKGBUILD`
is the intended path, and it means pacman owns the version pin.

### npm

```sh
npm install -g ocs
```

`ocs` declares `os: ["linux", "darwin"]`, so npm refuses the install outright on
anything else rather than installing a binary that cannot work.

This path depends on `@anthropic-ai/sandbox-runtime` being fetchable from the public
registry, since it is a normal runtime dependency and there is no global `srt` to
fall back to. **`ocs doctor` is the check**: it resolves the installed runtime and
reports its version, or tells you the install is incomplete. Run it before filing
anything else.

### macOS

```sh
npm install -g ocs
brew install ripgrep
```

No `socat` — macOS uses Seatbelt, which filters sockets by path and has no proxy
bridge to run.

**This path is implemented but unverified.** It has not been exercised on a Mac,
and the opencode state directories in the defaults are the Linux XDG layout, which
may differ under `~/Library/Application Support`. Expect to need extra `-m` grants
on first run; `ocs doctor` reports the platform as a warning rather than pretending
otherwise. Linux is the supported target.

### First run

```sh
ocs init
```

Writes `~/.config/ocs/config.json` with a conservative starting policy, and — if it
can — infers which model providers you use by reading your existing
`~/.config/opencode/opencode.json`, so the agent can actually reach its API. It
prints what it inferred; review it.

The built-in default is a single entry: `opencode.ai`, opencode's own Zen
endpoint, which works with `opencode auth login` and needs no key anywhere. The
point is that a first run is usable rather than a sandbox that silently cannot
call a model. Anthropic, OpenAI and Copilot also support `auth login`, but
reaching a paid API host by default is a wider grant than "try this out" needs —
name the ones you use in your own config, or let `ocs init` find them for you.

This file is where per-machine policy lives, and it is the file to edit for
anything you would otherwise repeat in every project. Lists there are **added to**,
never substituted: mentioning `network.allow` extends it, and there is no syntax
anywhere in `ocs` for removing an entry.

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
| `--print-config` | Print the compiled policy and exit. Runs no sandbox. |
| `--explain` | With `--print-config`, annotate each entry with its origin. |
| `--debug` | Pass `SRT_DEBUG=1` through to `srt`. |
| `-V, --version` / `-h, --help` | |

`-m`, `-w` and `-n` are a separate trust channel from both config files: you
typed them in your own shell, so they skip the containment gate that a
repository's config goes through. They are still resolved to absolute paths, and
they are reported as `cli` by `--explain`, so an entry that escaped the gate is
visible as such.

The same paths in a project config are rejected. That asymmetry is the point —
see [Security model](#security-model).

Two subcommands:

| Command | Effect |
| --- | --- |
| `ocs init` | Write a starting host config to `~/.config/ocs/config.json`. |
| `ocs doctor [project]` | Check that this machine can actually run the sandbox. |

### Verifying your install

```sh
ocs doctor
```

Run this first on any new machine, and first after any `npm install -g ocs`
upgrade. It is read-only — it starts no sandbox, resolves no policy, and changes
nothing — so it is safe to run while you are still setting things up.

It reports, and explains the consequence of each:

| Check | What a failure means |
| --- | --- |
| `bwrap`, `socat`, `rg` | Missing tools. `socat` in particular is close to silent: without it the sandbox comes up with **no network at all**, which looks exactly like a correct empty allowlist. |
| `apply-seccomp` | The helper that blocks `AF_UNIX`. `ocs` refuses to start without it rather than run with unblocked sockets. |
| `@anthropic-ai/sandbox-runtime` | Reports the pinned version actually loaded, so a stale install is visible. |
| `opencode` | Resolved through `PATH` and checked against the policy. |
| host config | Whether `~/.config/ocs/config.json` exists. |

Exits non-zero while anything required is missing.

#### If `opencode` is "outside every readable path"

`ocs` runs `opencode` *inside* the sandbox, so `opencode` itself has to be readable
under the compiled policy. A system-wide install at `/usr/bin/opencode` is covered
by the `/usr` grant and this never comes up. An opencode installed by its own
installer, by nvm, or into a user-local npm prefix lives under `$HOME` — and the
policy denies the home directory wholesale, re-opening only specific paths inside
it. Those four directories are opencode's *config and state*, never the directory
its *executable* happens to be in.

The failure is a bare `127`, which reads like a typo. So `ocs` checks before it
starts and refuses with the fix rather than letting you find out:

```
Refusing to start: 1 problem(s) with the command this sandbox exists to run.

  [FAIL] opencode: /home/you/.local/bin/opencode is outside every directory this
         policy can read
         ...
           ocs -m /home/you/.local/bin ~/Workspace/my-project
```

It never grants the path itself. Quietly adding wherever `opencode` happens to live
to the read mounts would make the check pass, and would also mean one command's
location silently becomes part of the security policy of every later run. Your
interpreter is checked too — `opencode` on a user-local node needs *both* granted,
and fixing only the first still exits `127`.

### Inspecting the policy

```sh
ocs ~/Workspace/my-project --print-config --explain
```

`--explain` prints every entry tagged with where it came from — `host`, `cli`, or
`project:my-project` — which is the fastest way to answer "what is this repo
actually asking for?"

Without `--explain`, `--print-config` emits the object handed to the sandbox
runtime, not an intermediate `ocs` representation. Read-deny globs are anchored
to absolute paths, `srt.*` settings are relocated to the keys the runtime reads,
and a policy that could not be enforced is an error rather than output. So the
JSON you see is the policy that would run.

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

`ocs` compiles the above into the `SandboxRuntimeConfig` object it passes to the
runtime. Keeping this table in your head is enough to read `--print-config` output.

Note that this is the shape shown in `srt`'s documentation; the package also exports
`FsReadRestrictionConfig` and `FsWriteRestrictionConfig`, which hints at a richer
schema for the filesystem half. The merge layer's output should be built against the
types in the installed package rather than against the docs.

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
**/.env, **/.env.*, **/.npmrc, **/.netrc, **/.git-credentials
```

These are the ones that actually matter, and the deny on `~` does not cover them:
the project is *inside* the home directory, and `allowRead` re-opens the whole
subtree, so a committed `.env` is readable unless something names it. That was
verified by running the sandbox with this list emptied, where `cat .env` printed
the secret.

`*.pem`, `*.p12`, `*.key`, `id_rsa*`, `credentials.json`, `service-account*.json`
and `.htpasswd` were in an earlier draft and removed. They are guesses about
filenames in a repository `ocs` cannot see, and each one multiplies the compiled
policy. Add them to your host config if your projects need them.

`.npmrc` and `.git-credentials` stay because they routinely contain live registry
and Git credentials, and they sit inside project directories. If a project
genuinely needs authenticated package installs, that has to be an explicit
host-config grant.

**Network.** Allow-only in `srt`. One entry by default — `opencode.ai`, opencode's
own Zen endpoint, which needs no key and works with `opencode auth login`. Every
other provider is yours to name; `ocs init` will infer the ones you already use
from `~/.config/opencode/opencode.json`.

### Which keys a project file may set

This is the core of the design, so it is worth stating plainly.

| Key | Project may… |
| --- | --- |
| `network.allow`, `network.deny` | add |
| `mounts.read`, `mounts.write` | add, **subject to containment** |
| `protected.read`, `protected.write` | add (adding a deny only tightens) |
| `srt.*` | **nothing — hard error** |

Lists are **unioned, never subtracted**, on every channel — host file, project
file, and command line alike. There is no syntax for removal anywhere in `ocs`,
so no config edit can be the reason a protection quietly stops applying. Only
`ocs`'s own defaults can be removed, by editing them.

That constraint is load-bearing in a way that is easy to get wrong. An earlier
version layered the host file over the defaults with a plain object spread, which
replaces a whole nested object: a user adding one glob to `protected.read` deleted
the built-in `.env` protection outright, and a user adding one mount deleted `/usr`
from the read grants. Nothing errored. Silently weaker on an unrelated edit is the
one outcome worth engineering against, so `applyHostConfig` merges group by group
and unions every list.

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

#### What the second clause does and does not allow

Naming a global grant is *accepted*, and that is a decision rather than an
oversight: it adds nothing, because every project already has it. A repo shipping
`mounts.read: ["../../.config/opencode"]` gets back the path it could already read,
so there is no widening to prevent — the gate is deciding "can this repo ask for
something it did not have", and it had it.

The consequence worth stating plainly is that a project config can therefore reach
`~/.config/opencode` on write. That is the open question in
[PLAN.md](PLAN.md) — the agent can rewrite its own model and MCP configuration —
and it is reachable through the global-grant allowance rather than through any
decision to allow it. It is inert today because those paths are already inside the
trust boundary of every session, and it is pinned by a test so the answer is
deliberate rather than incidental.

The system directories (`/usr`, `/etc`, …) are deliberately **not** in the grant
list, even though they are read defaults. They are in the policy because the
sandbox needs a userland to exist at all; a project naming one is a containment
failure. "Needed to boot" and "granted on request" are different claims and the
gate keeps them apart.

### Config tampering

`<project-path>/.ocs/config.json` is inside the writable project directory, so the
agent can edit its own policy file.

This is inert: `ocs` reads and compiles the policy once, at launch, and hands the
result to the sandbox runtime as an in-memory object. Nothing re-reads the file
during the session. Editing it mid-session has no effect on the running sandbox — it
takes effect the next time you run `ocs`, from your own shell, which is a decision
you make deliberately.

Because the policy never reaches the filesystem, there is no temp file to write
`0600`, no cleanup on signals, and no path an attacker could swap between compile
and enforcement.

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

### Unix socket blocking is ours to keep working

`srt` blocks `socket(AF_UNIX, ...)` with a seccomp filter applied by a static
helper binary it ships. It resolves that binary on the host and puts it on the
sandbox's command line, but does not bind it — which is fine for a global install
where it sits under a readable `/usr`, and not for a library dependency, where it
lives inside `node_modules` next to `ocs` and the read policy denies the home
directory.

`ocs` therefore binds that one file explicitly and names the same path in the
config, so the binary that is bound is the binary that is executed. Skip this and
every sandboxed command exits 127 with `apply-seccomp: No such file or directory`.

Because a seccomp filter that fails to load is invisible from the outside —
`srt` reports success — `ocs` does not take this on trust. If the policy says Unix
sockets are blocked and the helper cannot be found, it refuses to start and says
why, rather than starting a sandbox with an open route to every socket on the
host. The documented escape hatch (`srt.allowAllUnixSockets`, host config only)
still works, and on that setting no helper is bound at all since none is used.

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

### How relative patterns are resolved

Relative patterns in `protected.read` are expanded against the working directory
at *launch*, not against the project. `**\/.env` written in a config therefore
expands to nothing unless `ocs` happens to be started from the project tree — the
credential protection would silently protect nothing in the one situation nobody
would notice.

So `ocs` rewrites relative read-deny patterns against the project path before
handing them over. `**\/.env` becomes `<project>/**\/.env`, with the literal
directory Linux needs in order to walk anything at all. This is what makes the
built-in credential globs load-bearing rather than decorative.

The project is the only anchor. An earlier draft also anchored at opencode's own
state directories and `/tmp`; scanning all four opencode directories found zero
matches for every default pattern, so those anchors cost 52 entries in the
compiled policy and protected nothing. Anchoring under `/tmp` would walk all of it
on every launch to defend against a file nobody put there. A host config that
really does want a location covered can spell the pattern absolutely.

An absolute pattern is left alone, so an absolute root-anchored one (`**\/*.pem`)
is still refused — there is no directory above `/` to walk down from, and a rule
that protects a secret on one platform only is worse than no rule.

Patterns are also checked a second time after the runtime has expanded them,
because expansion is platform-dependent and a pattern that came in enforceable
can still come out unenforced. If anything in the compiled policy could not be
enforced, `ocs` refuses to start and says which pattern it was.

---

## Development

```sh
npm install
npm test          # unit + golden + adversarial; no sandbox required
npm run test:int  # integration; needs bubblewrap + socat
```

The test suite is mostly about the merge layer, because that is where the security
decisions live. Integration tests that actually invoke `bwrap` are a smaller,
separately-gated set, skipped when `bwrap` is absent.

One rule the suite holds itself to, learned the hard way: **a security assertion
must not derive its subject from the ambient environment.** Three separate bugs
here were assertions that passed on the author's machine and tested nothing
elsewhere — read-deny globs expanded against the working directory, and an
adversarial fixture built in `os.tmpdir()` whose `../../etc` resolved to `/etc` at
the default `TMPDIR` and to `/tmp/etc` — an already-granted path — anywhere deeper.
The adversarial suite now builds its fixtures in the home tree and asserts that
premise explicitly, so moving them somewhere granted fails loudly instead of
quietly.

Two of those integration tests exist because the bugs they cover were invisible to
unit tests that only inspect the compiled policy:

- **Exit-status propagation.** A failing command must report failure. (`srt` ≤ 0.0.77
  reported exit 0 under zsh.)
- **Unix socket blocking, in both directions.** Confirmed by binding an `AF_UNIX`
  listener inside the sandbox and checking it is refused — and confirming that
  `allowAllUnixSockets: true` makes the same probe succeed. The second half is the
  control: without it the first half would also pass on a machine where the policy
  had no effect at all.

Known gaps, in rough priority order, are tracked in [PLAN.md](PLAN.md). The two
that most affect anyone trying this: macOS is unverified, and violation attribution
is not yet wired up.

### Design notes: why the library, not the CLI

`srt` ships both a CLI and a library. `ocs` uses the library, behind a narrow
internal interface (`SandboxRunner`) that the rest of the codebase never sees.

**What that buys us:**

- **One executable.** No `srt` on `PATH` for something unrelated to invoke with
  implicit defaults. For a tool whose entire job is not being invoked
  accidentally, that matters more than it sounds.
- **No temp file.** The CLI only accepts a settings *path*, which is what forced the
  write-`0600`-to-a-runtime-dir-and-clean-up-on-signal design. The library takes the
  config object directly, so that entire code path — and the window in which a
  compiled policy sits on disk — does not exist.
- **Real violation attribution.** The library exposes a keyed violation store and
  `annotateStderrWithSandboxFailures()`, so a blocked operation can be reported back
  with the actual reason. Through the CLI the only visibility is scraping stderr or
  setting `SRT_DEBUG`.

**What it costs:**

- **Coupling to an explicitly unstable API.** `srt` calls itself a research preview
  and says its APIs may evolve. We would be reading upstream source to adapt when a
  `0.0.x` release breaks something. The mitigation is that this is not really a
  choice between stable and unstable — if the config format or the `--settings`
  handling changes, the CLI approach breaks too. The interface puts the risk in one
  place.
- **We still spawn a shell.** `wrapWithSandbox()` returns a command *string* that must
  be run with `{ shell: true }`, because `srt` bakes the `bwrap` arguments into a
  `/bin/sh -c` invocation either way. We just skip its argument parsing. The command
  is only ever `opencode` plus pass-through args, so this is manageable — but it is
  not the shell-free design it can appear to be.

The `SandboxRunner` interface exists so this stays reversible. `LibraryRunner` and a
`CliRunner` are both implementable behind it, and the spike in M0 deliberately
validates against the CLI first because that is the documented happy path — it is the
quickest way to confirm `socat`, the network proxy and the mount policy actually work
on the host, before any of it is wired to the library.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime) — the sandbox primitive. `ocs` would not exist without it.
- [bubblewrap](https://github.com/containers/bubblewrap)
- [Guillaumea's writeup](https://blog.guillaumea.fr/post/sandboxing-opencode-ai-agents-bubblewrap-srt/) — the idea, and the reason to expect more of these.