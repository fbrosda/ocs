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
  #
  # `--ignore-scripts`: nothing here needs a lifecycle script. TypeScript is
  # invoked through `npm run build`, and no production dependency ships a
  # preinstall/install/postinstall. Running them as the build user on every
  # makepkg is reproducibility handed away for nothing.
  npm ci --ignore-scripts

  npm run build
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

  # The prune is here, not in check(), because `makepkg --nocheck` skips
  # check() entirely — which would package the whole dev tree (typescript,
  # vitest, eslint: about 100MB of it). Nothing needed at runtime is a
  # devDependency; srt's own dependencies stay, they are production ones.
  npm prune --omit=dev

  # Everything the runtime touches at execution time: the compiled CLI and the
  # dependency tree that sits beside it, under /usr/lib/ocs.
  #
  # `cp -a`, not `install`: the tree is directories all the way down, it
  # contains relative symlinks (`node_modules/.bin/srt`), and it contains
  # executables — srt's apply-seccomp and its own dist/cli.js. `install`
  # dereferences the symlinks, refuses the directories, and takes the exec bits
  # off with -m 644.
  #
  # install -d first because `cp -a a b dest/` copies *into* dest and requires
  # it to exist; without it the copy fails outright rather than creating it.
  install -d -m755 "$pkgdir/usr/lib/ocs"
  cp -a dist node_modules "$pkgdir/usr/lib/ocs/"

  # Declarations exist to typecheck source trees. Nothing at runtime opens one,
  # and npm's node_modules/.package-lock.json records per-package *tarball*
  # integrity rather than a file list, so nothing downstream notices either.
  #
  # A rule, not a list of paths: a dependency shipping more, fewer or
  # differently-named declarations next release needs no edit here. `*.d.ts`
  # alone is not enough — zod v4 ships 212 `.d.cts`, a third of the payload.
  #
  # Scoped to $pkgdir and never to $startdir: this is a VCS build, so
  # $startdir is the user's own checkout, and check() has already run the test
  # suite against it.
  find "$pkgdir/usr/lib/ocs" -type f \
    \( -name '*.d.ts' -o -name '*.d.ts.map' -o -name '*.d.cts' -o -name '*.d.mts' \) \
    -delete

  install -Dm644 package.json "$pkgdir/usr/lib/ocs/package.json"
  install -Dm644 LICENSE "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
  install -Dm644 README.md "$pkgdir/usr/share/doc/$pkgname/README.md"
  install -Dm644 ocs.schema.json "$pkgdir/usr/share/doc/$pkgname/ocs.schema.json"

  # A wrapper rather than a symlink into /usr/lib, because the CLI resolves
  # node_modules relative to its own real path (`createRequire(import.meta.url)`
  # in src/sandbox/seccomp.ts) — the same reason it has to be a real path rather
  # than a $PATH lookup that happens to work.
  install -Dm755 ocs "$pkgdir/usr/bin/ocs"

  # Assert, do not chmod. `cp -a` above carries modes over verbatim, so if the
  # exec bit is not there now it is because the prune dropped the file or npm
  # shipped it wrong — and patching the mode would hide that. ocs refuses to
  # start without this binary rather than running with unblocked AF_UNIX
  # (src/sandbox/seccomp.ts), so a package that loses it fails at first use,
  # far from the build that caused it.
  local seccomp found=
  for seccomp in "$pkgdir"/usr/lib/ocs/node_modules/@anthropic-ai/sandbox-runtime/vendor/seccomp/*/apply-seccomp; do
    if [[ -x $seccomp ]]; then
      found=1
    fi
  done
  if [[ -z $found ]]; then
    echo "apply-seccomp is missing or not executable in \$pkgdir; refusing to package ocs without it" >&2
    return 1
  fi
}
