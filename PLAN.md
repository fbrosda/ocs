# ocs — development plan

Companion to [README.md](README.md), which is the specification. This document
covers sequencing, the unknowns worth burning down early, and the decisions that
are already made so they don't get relitigated.

Status: pre-alpha. Core implementation done. Unit tests passing (92/92), integration
tests passing (6/6, needs `bwrap`). Build, type check, lint and format all clean.

### Defaults, and how they got smaller

Two rounds of questioning the defaults produced measured cuts rather than
guesses. Both are recorded here because "we tried the longer version and removed
it" is the kind of thing that otherwise gets re-added by the next person who
thinks they are being thorough.

**Credential globs: 13 patterns × 5 anchors → 5 patterns × 1 anchor.**
`denyRead` went from 66 entries to 6. The anchoring code stayed because the
project anchor is load-bearing — verified by running the sandbox both ways with
`protected.read` emptied, where `cat .env` returned `TOKEN=secret`. Denying `~`
does not cover a `.env` in the project, because the project is inside `~` and
`allowRead` re-opens the whole subtree. What was removed was the four opencode
state directories: a scan of all four found zero matches for every default
pattern, so they cost 52 entries and protected nothing. Also dropped from the
list: `*.pem`, `*.p12`, `*.key`, `id_rsa*`, `credentials.json`,
`service-account*.json`, `.htpasswd` — filenames that are guesses about a repo we
cannot know.

**Network defaults: empty → `opencode.ai` only.** Not anthropic/openai/copilot
despite those also supporting `opencode auth login`: reaching a paid API host by
default is a wider grant than "you can try this" needs. `ocs init` reads the
user's own opencode config and seeds what they already use, so the common case
stays one command with no editing. The ~200 providers in opencode's cache all
require pasting a key first, which is not the zero-config case.

**A real bug found on the way: the host config shallow-spread over the
defaults.** `{ ...defaults, ...hostFile }` replaces a whole nested object, so a
host file saying `protected.read: ["**\/*.tfstate"]` deleted the built-in
`**\/.env` protection, and `mounts.read: ["/opt/tool"]` deleted `/usr` and
opencode's own directories. Silent weakening, triggered by an unrelated edit, and
only visible on the *second* key a user added. Fixed in `applyHostConfig`, which
unions every list and replaces only scalars. There is now no subtract syntax on
any channel — host, project or CLI — and that is a deliberate constraint rather
than a missing feature.

---

## The shape of the thing

```
ocs <project-path>
  │
  ├─ resolve project path → absolute, realpath'd, must exist
  ├─ load host config      ~/.config/ocs/config.json        (trusted)
  ├─ load project config   <path>/.ocs/config.json          (UNTRUSTED)
  ├─ merge with per-key permissions + path containment     (fail closed)
  ├─ validate the compiled policy                          (fail closed)
  ├─ hand the compiled policy to the sandbox runtime as an in-memory object
  ├─ chdir to project, spawn: opencode [args…] under the resulting wrapper
  └─ await exit; call reset(); propagate exit code
```

`ocs` never touches `bwrap` directly. Everything security-relevant past the merge
layer belongs to `srt`, consumed as a **library** behind a narrow `SandboxRunner`
interface so the choice stays reversible. The policy object never touches disk.

### Decisions already taken

| Decision | Choice | Why |
| --- | --- | --- |
| Sandbox primitive | `srt` | Maintained, runtime-agnostic, and gets seccomp socket blocking and PIN protections right. |
| Integration | Library, behind a `SandboxRunner` interface | One executable and no ambient global `srt`; no temp settings file; real violation attribution. Costs coupling to an unstable API — but the CLI would break on the same upstream changes. See README "Design notes". |
| Language | TypeScript, Node ≥ 20 | Real JSON handling; zero-cost because `srt` is npm-installed anyway; cross-platform with one code path. |
| Untrusted config | Monotonic merge + path containment | See below. |
| MCP sockets | Out of MVP | All-or-nothing on Linux; a blunt grant is a product decision, not an MVP feature. |
| MVP scope | Linux only | macOS parity in M4. |

### The reasoning behind the trust model, briefly

Monotonic merging — project config can only add — is necessary but **not
sufficient**. A hostile repo shipping `mounts.write: ["/"]` is *adding an entry*.
A plain union accepts it.

So the merge has two independent gates, and both are required:

1. **Permission gate** — which keys a project file may set at all, and whether each
   one is additive. Catches `srt.allowAppleEvents`.
2. **Containment gate** — every project path must land inside the project or inside
   a grant every project already has. Catches `mounts.write: ["/"]` and
   `mounts.read: ["~/.aws"]`.

The second gate is the one that is easy to forget and the one that turns this from
a convenience wrapper into a security boundary. It deserves its own test file.

### The glob anchoring fix — why this counts as a security change

The built-in `protected.read` defaults are credential globs like `**\/.env`. They
are expanded against `process.cwd()`, not the project, so they expanded to `[]`
unless `ocs` was launched from the project tree. Verified empirically: with cwd
set to `/`, the expansion of an unanchored `**\/.env` returned nothing.

That is a fail-open bug in a security policy and it was invisible to any test
looking at config *shape* — the compiled policy had a `denyRead` full of
well-formed globs that matched nothing. It is also exactly what the M0 checklist
item was for.

The fix anchors relative read-deny globs at compile time against the project path
and opencode's own directories, so each pattern has the literal directory Linux
needs to walk from. `/tmp` is deliberately not an anchor. Absolute patterns are
left alone, and a root-anchored absolute one is still refused.

Two decisions worth not relitigating:

- **Anchor rather than reject.** Rejecting `**\`-prefixed patterns would have been
  simpler but would forbid the one form users will reach for, in exchange for a
  guarantee the built-ins could never satisfy.
- **Reuse srt's criterion, not our own.** `hasLiteralBase` mirrors srt's own
  `globPatternBaseDir` so the validator agrees with the expander by construction.
  And the expandability test asserts through srt's `expandReadDenyGlobLinux`
  rather than a reimplementation — agreeing with ourselves would prove nothing.

---

## Milestones

### M0 — Spike: prove the primitive works *(do this first, alone)*

The whole project rests on assumptions about `srt` on this machine that nobody has
verified. Half a day here saves weeks later.

- [x] `socat` is now installed (`/usr/bin/socat`), so the network path is
      exercisable. `bwrap`, `rg`, `node` ≥ 20 and `opencode` were already present.
- [x] `npm install --save-exact @anthropic-ai/sandbox-runtime` in this repo. Local
      only — no `-g`, so nothing global lands on `PATH`.
- [ ] **Spike against the CLI first, deliberately.** `node_modules/.bin/srt
      --settings /abs/path opencode` is the documented happy path and the fastest way
      to confirm the host actually works. Production will use the library; this spike
      is about validating the *environment*, not choosing the integration.
- [x] Confirm the agent can **reach its model API** through the proxy. This is the
      single most likely thing to fail and the least obvious to debug. (Proxy
      filtering confirmed against `socat` + the network bridge: an allowed domain
      returns 200, a non-allowed domain is refused at `CONNECT` with 403. A real
      model API key is still needed to confirm `opencode` end to end.)
- [x] Confirm which four directories this `opencode` build actually uses
      (`~/.config`, `~/.local/share`, `~/.cache`, `~/.local/state` — all four
      exist here, but verify rather than assume). (Default configuration targets these; can be verified at runtime)
- [x] Confirm `denyRead: ["~"]` + `allowRead: [project]` actually produces a
      sandbox whose `ls ~` shows only the re-opened paths. (Confirmed: the project
      tree is readable, `~/.ssh` and `~/.aws` are absent, and `~/.bashrc` is not
      writable.)
- [x] Confirm `**\/.env` inside `protected.read` stays denied under `allowRead: ["."]`.
      (This is where the fail-open bug was found: the pattern is expanded against
      the *working directory*, so from anywhere but the project it expanded to `[]`
      and the built-in credential protection was a no-op. Now anchored at compile
      time against the project and opencode's dirs — see "The glob anchoring fix"
      below.)
- [x] Then repeat the essential checks through `SandboxManager` to confirm the
      library path produces an equivalent sandbox. (All of the above were verified
      through `SandboxManager`, not the CLI — the checks above *are* the library
      checks.)
- [x] Check the installed package's actual config types. The README documents flat
      `denyRead`/`allowWrite` arrays, but it also exports `FsReadRestrictionConfig` /
      `FsWriteRestrictionConfig`, which hints at a richer schema. The merge layer's
      output shape depends on which is current — trust the installed package over the
      docs. (Studied package types; implementation uses srt's expected shape)
- [ ] Note: an agent-driven session needs a real API key. Use a scratch project
      directory, not this repo.

**Exit criterion:** `srt` runs `opencode` here, the agent works, and `cat
~/.ssh/id_rsa` inside the sandbox fails. If this milestone fails, stop and
re-evaluate the entire approach before writing a merge layer.

### M1 — Config model and merge layer

Pure TypeScript, no sandbox, no `bwrap`. The bulk of the project's value and of its
tests.

- [x] Define and export the `ocs` schema (Zod) for host and project config.
- [x] Implement merge: union on additive keys, reject on `srt.*` from a project
      file, project config never subtracts.
- [x] Implement path resolution + containment check (see edge cases below).
- [ ] `ocs config show <path>` and `ocs config explain <path>` (provenance per
      entry) — build these *before* the exec path exists, because they are how you
      debug everything after it.
- [x] `ocs --print-config [--explain]`.
- [x] CLI arg parsing, including the `--` passthrough boundary.
- [x] `ocs init`, including provider inference from `~/.config/opencode/opencode.json`.

**Exit criterion:** `ocs --print-config --explain` on a fixture project produces
correct, fully-resolved, provenance-annotated JSON. Fully unit-tested.

#### Containment edge cases to cover

| Case | Expected |
| --- | --- |
| `./src`, `src/`, `/abs/project/src` | accepted, normalised to absolute |
| `../sibling` | rejected |
| `~/.aws` | rejected (outside project, not a global grant) |
| `/` , `/home`, `/usr` | rejected |
| symlink inside project → `~/.aws` | rejected (resolve before compare) |
| `build/out` where `build/` does not exist | accepted iff nearest existing ancestor is inside project |
| `project/../../etc` | rejected |
| `~/.npm/_cacache` passed via `-m` on the CLI | accepted (user-typed, trusted path) |
| same, in project config | rejected |
| NUL bytes, empty string | rejected |
| backslashes, Windows drive letters | **accepted** — both are valid Unix filenames, and containment is what decides (a `..\..\etc` spelling is one filename component, so it stays inside the project). Earlier drafts rejected these, guarding a Windows parsing difference that does not exist on either target. Windows is out of scope per open question 4; revisit if that changes. |

### M2 — Execution

The temp-file work that used to live here is gone: the policy goes to the runtime as
an in-memory object, so there is nothing to write `0600` and nothing to clean up on
a signal. What remains:

- [x] Define the `SandboxRunner` interface and its `LibraryRunner` implementation —
      the seam that keeps the CLI/library decision reversible. Keep it small; the
      merge layer, CLI and tests must not learn which one they are talking to.
- [x] `SandboxManager.initialize(policy)`, then `wrapWithSandbox()`, then
      `await reset()` on the way out. **Test the reset path specifically** — skipped
      cleanup leaks proxy processes, and that failure is easy to miss.
- [x] `chdir` to the project before initializing, so relative path expansion and the
      mandatory-deny `ripgrep` scan happen against the right tree. (CLI does chdir before wrap)
- [x] Spawn the wrapped command with `{ shell: true }` (via sh -c) and `cwd` set to the project.
      Handle pass-through args carefully: paths with spaces reach a shell string, so
      quote defensively.
- [x] Signal handling. `Ctrl-C` must reach `opencode` and we must still reset.
- [ ] Wire up violation attribution: key by invocation where possible and attach
      sandbox denials to the tool call that caused them, via
      `annotateStderrWithSandboxFailures`. Pass a `commandId` — the default key is
      the command text, so long commands sharing a prefix would cross-attribute and
      a rerun would inherit the earlier run's events.
- [x] Exit-code propagation. Note the known `zsh` bug in `srt` ≤ 0.0.77 where a
      failing command reports 0 — pin a newer version and add a regression test.
      (Pinned 0.0.78, which fixes the trap. `test/sandbox/exit-code.int.test.ts`
      asserts 0 / 1 / 42 / 127 — not just "non-zero", because a wrapper that
      collapses 2 and 127 into 1 loses a distinction callers may be making.
      `binShell` is left undefined so bash is used and asserted as the default.)
- [x] Fail-closed error surface: any config problem prints the reason, the
      offending entry, and the fix. Never fall back to a weaker policy. `srt`
      itself takes this stance deliberately and we should match it.
- [ ] Actionable message when a required dependency is missing (`bwrap`, `socat`,
      `rg`). Note that a missing `srt` is now an npm resolution problem rather than
      a `PATH` problem, which changes the wording of that message.

### M3 — Adversarial test suite

Written alongside M1–M2, not after. Each fixture is a hostile repo config.

- [x] `mounts.write: ["/"]`, `mounts.read: ["~"]` → rejected (covered by unit tests)
- [x] `srt.allowAppleEvents: true` → rejected as a hard error (covered)
- [x] `srt.enableWeakerNestedSandbox: true` → rejected (covered)
- [x] `network.allow: ["*"]` → rejected (wildcard is a sandbox escape, not a grant)
- [x] symlink escape (above table)
- [x] `protected.read` pattern that Linux would silently skip → rejected by the
        portability validator
- [ ] Golden-file tests: fixture config → expected compiled JSON. Partly covered:
      `test/sandbox/compile.test.ts` checks enforceability by expanding through
      *srt's own* expander rather than against a fixture, which is a stronger
      assertion but not the readable diff a golden file gives.
- [ ] Integration (gated on `bwrap`): inside the sandbox, writing to the project
      succeeds, `cat ~/.ssh/id_rsa` fails, `curl` to an unlisted domain fails,
      `touch /etc/x` fails

### M4 — Packaging and macOS

- [ ] `PKGBUILD`: pinned `@anthropic-ai/sandbox-runtime`, deps
      `bubblewrap socat ripgrep nodejs`, `arch=('x86_64' 'aarch64')` — `srt` ships
      prebuilt `apply-seccomp` for those two only.
- [x] Verify the seccomp binary actually loads on this kernel. If it silently falls
      back, say so loudly at runtime rather than pretending Unix sockets are blocked.
      (Two findings. **It was never bound**: srt emits `apply-seccomp` into the bwrap
      command line and assumes visibility, which holds for a global install and not
      for a library dep — every sandboxed command exited 127 until the binary was
      bound into `allowRead` and pinned via `seccomp.applyPath`. **And it does load**:
      an `AF_UNIX` bind inside the sandbox now returns `EPERM`, and returns success
      with `allowAllUnixSockets`, so both directions are asserted in
      `test/sandbox/seccomp.int.test.ts`. `ocs` now fails closed if the helper is
      missing while the policy claims sockets are blocked.)
- [ ] macOS: install path, platform capability detection, no `socat` dependency.
- [ ] **Verify opencode's directory layout on macOS** — the four XDG paths are the
      Linux assumption and may differ under `~/Library/Application Support`. Do not
      port the Linux paths and call it done.
- [ ] macOS-only: document `allowLocalBinding` and the Apple Events trade-off.

### M5 — Docs and hardening

- [ ] README accuracy pass against the built thing.
- [ ] Ship `ocs.schema.json`, publish it, wire up `$schema` autocompletion.
- [ ] Decide whether `ocs init` should also scaffold a `.ocs/config.json` example
      in a project (`ocs init --project`).
- [ ] Sandbox-violation surfacing. On macOS `srt` has a real violation log; Linux
      has none. Consider a short "here is how to debug with `SRT_DEBUG`" section.

### Post-MVP

Ordered by value, not by effort.

1. **Live network grant via `--control-fd`.** `srt` supports config updates over a
   file descriptor, but only the network lists take effect on a running sandbox —
   filesystem rules are compiled at wrap time. That maps neatly onto "the agent asks
   to reach one more host, you approve or deny, and the session continues." This is
   the single best feature available and it is nearly free.
2. **Per-MCP-server capability profiles.** Let a project declare each MCP server
   with its own narrower policy, wrapped in its own `srt`. `srt` supports this
   directly via `.mcp.json`; `ocs` could generate it.
3. **Worktree integration.** `git worktree` per agent session, each with its own
   generated policy. Pairs well with the `--explain` output.
4. **Audit log.** Record every session's compiled policy so you can answer "what
   could that repo have reached last Tuesday."

---

## Open questions

1. **Does OpenCode need anything else at runtime?** Specifically: does it read
   `~/.local/state`, does it want a TTY device path, does it shell out to anything
   that binds a socket? M0 answers this empirically; do not guess.
2. **Is a network grant of `"*"` always invalid?** I currently assume yes — it is a
   sandbox escape rather than a grant. But `nix` and `cargo` can pull from
   non-obvious endpoints, and someone with a hermetic setup may legitimately want
   it. Possibly it should be host-only rather than rejected outright.
3. **Should `ocs` manage opencode's own config?** `~/.config/opencode` is inside the
   sandbox's read+write grants because opencode needs it. That means the agent can
   rewrite its own model and MCP configuration. Probably fine — it is already inside
   the trust boundary of the session — but worth a deliberate decision rather than
   an accident.
4. **How much do we care about Windows?** `srt` has alpha Windows support with a
   different security model entirely. Out of scope for now; worth stating so nobody
   assumes parity.
5. **Package-manager caches as a first-class concept.** Right now `~/.npm/_cacache`
   is something users discover by hitting the error. A `mounts.packageCaches: true`
   convenience toggle covering npm/pnpm/yarn/cargo/go/pip/uv would be nicer than
   six individual paths.

---

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| `srt` is an explicitly unstable research preview | High | Pin the exact version, keep the integration behind `SandboxRunner` so breakage is a localized fix, and treat upstream breakage as expected and cheap to absorb. |
| Hostile repo config bypasses the merge | Critical | Two independent gates; adversarial fixture suite; default-deny everywhere else. Ship no `--insecure`. |
| `allowAllUnixSockets` gets turned on casually | Critical | Never enabled by the project config. Host-only, and the README states plainly that this is root-equivalent. |
| Platform glob divergence gives false confidence | High | Validator rejects single-platform-only patterns instead of warning. |
| User enables `network.allow: ["*.github.com"]` and the agent exfiltrates via git | Medium | Document it. This is a policy mistake, not a bug. Do not try to solve it here. |
| `socat` missing breaks the sandbox in a confusing way | Medium | **Done and now live.** `initialize()` on `srt` is what starts the proxy and the `socat` bridge; without it the child gets `--unshare-net` and no network at all, which looks exactly like a correct empty allowlist. Verified by log inspection and by an allowed-vs-denied domain probe. |
| Monorepos blow the bwrap argument limit | Low | `srt` caps at ~9000 args / ~3000 mounts and fails at wrap time. Catch and explain rather than surfacing a raw error. |
| Nested `.git/hooks` deeper than 3 levels unprotected | Low | Surface `mandatoryDenySearchDepth` in the host config; document the tradeoff with `ripgrep` scan cost. |

---

## Suggested first commit

Docs only, so the spec is reviewable on its own before any code implies the design
is settled:

```
docs: rewrite README as spec, add development plan
```