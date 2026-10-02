# AGENTS.md

Guidance for coding agents working in this repository.

## What this is

`ocs` runs OpenCode inside an OS-level sandbox. It compiles a per-project policy
into a config and hands it to [`srt`](https://github.com/anthropic-experimental/sandbox-runtime)
(Anthropic's Sandbox Runtime), which enforces it with bubblewrap on Linux and
Seatbelt on macOS.

`ocs` implements **no sandboxing itself**. Everything security-relevant past the
config-merge layer belongs to `srt`.

## Read these first

- `README.md` — the specification. It is the source of truth for behaviour.
- `PLAN.md` — sequencing, decisions already made, open questions.

Do not change behaviour that contradicts either document without saying so
explicitly in your commit message.

## Security invariants

These are the design. A change that breaks one of them is a bug even if the tests
pass.

1. **Project config may only add. Never subtract.** A repository's config is
   untrusted — it arrives with `git clone`. It can extend allowlists; it can never
   remove an entry, and there will be no syntax for doing so.
2. **Monotonic merging is not sufficient on its own.** A hostile repo shipping
   `mounts.write: ["/"]` is *adding* an entry, so a plain union accepts it. The
   path-containment gate is the second, independent check and is what actually
   makes untrusted config safe. Do not treat it as redundant validation.
3. **`srt.*` settings are host-only, and their absence from project config is a
   hard error, not a warning.** `allowAppleEvents` and `allowAllUnixSockets` do not
   widen the sandbox, they remove it.
4. **Fail closed, always.** Any error resolving, merging or validating a policy
   means `ocs` exits non-zero and runs nothing. There is deliberately no fallback
   to a weaker policy and no `--insecure` flag. Do not add one.
5. **Do not shell out to `bwrap` directly, and do not call `srt` as a subprocess.**
   Go through the `SandboxRunner` interface (`src/sandbox/runner.ts`). `srt` is an
   unstable research preview; confining that instability to one small adapter is the
   entire point. Nothing outside `src/sandbox/` should import
   `@anthropic-ai/sandbox-runtime`.
6. **`reset()` the sandbox runtime on every exit path.** It tears down the network
   proxies; skipping it leaks processes. A leak here is easy to miss in tests and
   annoying in real use.

## Do not "fix" the hostile fixtures

`test/fixtures/hostile/` will contain configs that attempt sandbox escapes —
`mounts.write: ["/"]`, `srt.allowAppleEvents: true`, symlinks pointing at `~/.aws`.

They are **intentionally malicious**. They are test inputs, not vulnerabilities.
Deleting them, "correcting" them, or adding `srt: { allowAllUnixSockets: false }`
to make one of them pass breaks the test suite's entire reason to exist.

Each fixture should correspond to a case in the containment table in `PLAN.md`.

## Environment constraints

- **Never use `sudo`, and do not work around a missing dependency either.** If
  something required is absent, stop and tell the user exactly what to install and
  why. Do not install it yourself, do not fetch a static binary into `~/.local/bin`,
  do not shim it. Package installation is the user's call, not the agent's.
- **Linux is the primary target.** macOS parity is in the plan but unproven. Do not
  assume macOS-specific behaviour has been verified here.
- `srt` is pinned to an exact version as a normal library dependency — not installed
  globally, and not on `PATH`. Do not bump it casually: versions ≤ 0.0.77 have a zsh
  bug where a failing command reports exit 0, and the whole point of depending on it
  is that its behaviour is predictable.
- `socat`, `bwrap` and `ripgrep` are present on this machine, so the Linux sandbox
  path — including the network proxy — is exercisable here. The rule above still
  applies if one is ever missing: report it, do not install, vendor or shim it.

## Commands

Not yet wired up — the repository is spec-only as of the initial commit.

```sh
npm test          # unit, golden and adversarial suites; no sandbox required
npm run test:int  # integration; needs bubblewrap + socat
npm run build     # compile to dist/
```

The unit suite is the bulk of the value and needs no privileges, no `bwrap`, and no
network. Integration tests that actually invoke the sandbox are gated separately.

## Conventions

- TypeScript, Node ≥ 20, strict mode.
- Comments should explain *why*, particularly around the merge layer. The security
  reasoning is the part that is not recoverable from the code.
- Do not commit real credentials, API keys, or a populated `~/.config/ocs/`.