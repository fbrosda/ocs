# Maintainer: Fabian Brosda <f.brosda@gmx.de>
#
# Builds from the tree this file sits in, so `git clone && makepkg -si` works
# without a published tarball. There is deliberately no separate
# `sandbox-runtime` package: `ocs` depends on `@anthropic-ai/sandbox-runtime` as
# a normal library dependency, so the runtime and its pinned version live inside
# `ocs`'s own node_modules and there is no global `srt` for anything else to
# pick up.
#
# The version pin is not repeated here on purpose. `npm ci` installs from
# package-lock.json, which is the single place the exact sandbox-runtime version
# is recorded — a second copy in this file would be a second thing to forget to
# bump.

pkgname=ocs
pkgver=0.0.1
pkgrel=1
pkgdesc="Run OpenCode inside an OS-level sandbox with a per-project policy"
arch=('x86_64' 'aarch64')
# No url= until there is a remote to point at. A guessed link in a package page
# is worse than none, and makepkg does not require it.
license=('MIT')
depends=('nodejs' 'bubblewrap' 'socat' 'ripgrep')
makedepends=('npm')
optdepends=(
  'opencode: the agent this tool exists to sandbox (https://opencode.ai)'
)
provides=('ocs')
# No conflicts: nothing else installs an `ocs` binary.

# No `source=()`. This is a VCS build, and pacman takes the tree in the current
# directory. `npm ci` needs the lockfile, which is committed.
build() {
  cd "$startdir"

  # `npm ci` rather than `npm install`: it installs the lockfile exactly and
  # wipes any node_modules that happens to be lying around, so the build cannot
  # pick up a package the lockfile does not name.
  npm ci

  npm run build

  # Everything needed at runtime is a production dependency, so the dev tree
  # (typescript, vitest, eslint — about 100MB of it) has no business in the
  # package. srt's own dependencies stay: they are production dependencies.
  npm prune --omit=dev
}

check() {
  cd "$startdir"

  # Unit tests only. They need no bubblewrap, no privileges and no network,
  # which is what makes them the right thing to run inside PKGBUILD.
  #
  # The integration suite is deliberately not run here: it needs a working
  # sandbox, which is exactly what the machine running makepkg may not have.
  npm test
}

package() {
  cd "$startdir"

  # Everything the runtime touches at execution time: the compiled CLI and the
  # dependency tree that sits beside it. The bin directory comes first so the
  # wrapper is on PATH ahead of anything else.
  install -dm755 "$srcdir/dist" "$pkgdir/usr/lib/ocs/dist"
  install -dm755 "$srcdir/node_modules" "$pkgdir/usr/lib/ocs/node_modules"

  install -Dm644 package.json "$pkgdir/usr/lib/ocs/package.json"
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
  install -Dm644 ocs.schema.json "$pkgdir/usr/share/doc/$pkgname/ocs.schema.json"

  # A wrapper rather than a symlink into /usr/lib, because the CLI resolves
  # node_modules relative to its own real path (`createRequire(import.meta.url)`
  # in src/sandbox/seccomp.ts) — the same reason it has to be a real path rather
  # than a $PATH lookup that happens to work.
  install -dm755 /dev/stdin "$pkgdir/usr/bin/ocs" <<'EOF'
#!/bin/sh
exec /usr/bin/node /usr/lib/ocs/dist/cli.js "$@"
EOF

  # The seccomp helper that blocks AF_UNIX is inside node_modules and is not
  # executable-by-default in some archives; make sure it survived the prune and
  # is executable, because ocs refuses to start without it rather than running
  # with unblocked sockets.
  local seccomp
  for seccomp in "$pkgdir"/usr/lib/ocs/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/*/apply-seccomp; do
    if [[ -e $seccomp ]]; then
      chmod 755 "$seccomp"
    fi
  done
}
