import { OcsConfig } from "./types.js";
import {
  getOcsRuntimeDir,
  getOpencodeBaseDirs,
  getSystemReadDirs,
  getTempDirs,
} from "./paths.js";

/**
 * Credential filenames worth denying wherever they turn up in the project.
 *
 * These are relative double-star patterns on purpose: `buildSrtConfig` anchors
 * them against the project at compile time, which is what makes them enforceable
 * on Linux at all. Do not "fix" these to be absolute-by-hand for one project —
 * that would leave every other project uncovered. See `src/config/globs.ts` for
 * why this shape is load-bearing.
 *
 * The list is short on purpose. Longer lists were tried — private keys, `.p12`,
 * `credentials.json`, `service-account*.json`, `.htpasswd` — and removed: they
 * multiply the compiled policy for filenames no one commits, and a deny nobody
 * can predict is a deny that cannot be reasoned about. What is here is the
 * category that actually shows up in a cloned repository, and each one is a
 * committed secret rather than a build artefact.
 *
 * `.npmrc`, `.netrc` and `.git-credentials` are in the same category as `.env`:
 * live registry and Git credentials, routinely committed by accident, sitting in
 * exactly the directory the allow re-opens. Note that a deny on the home
 * directory does *not* cover these — the project is inside the home directory
 * and `allowRead` re-opens the whole subtree, so only these globs keep a
 * committed `.env` unreadable.
 *
 * Keys (`*.pem`, `id_rsa*`) were dropped from the defaults. A private key in the
 * project tree is a much rarer accident than a `.env`, and srt's mandatory write
 * denies plus the home-directory deny still cover the keys that matter. Users
 * who want them can add the patterns to their host config.
 */
const PROTECTED_READ_DEFAULTS = [
  "**/.env",
  "**/.env.*",
  "**/.npmrc",
  "**/.netrc",
  "**/.git-credentials",
];

/**
 * The floor every session starts from, applied before either config file, so a
 * project with no config at all is still confined.
 *
 * Read: a userland to run in, plus the directories opencode needs to start.
 * Write: only the project, opencode's own state, and the temp directories.
 * Network: nothing. `ocs init` seeds a curated allowlist on top.
 */
export function getDefaultHostConfig(): OcsConfig {
  return {
    network: {
      // One entry, and it is the one that needs no configuration at all:
      // opencode's own Zen endpoint. `opencode auth login` does its own OAuth or
      // device flow for it, so a first-time user has working model access without
      // pasting a key anywhere.
      //
      // Deliberately not anthropic/openai/copilot. Those also support
      // `auth login`, but a sandbox that reaches a paid API host by default is a
      // wider grant than "you can try this" needs, and the user's own config is
      // the place to name a provider they have chosen. `ocs init` reads
      // ~/.config/opencode/opencode.json and seeds what is already in use, so the
      // common case is still one command with no editing.
      //
      // An allowlist this short is the point, not an oversight: a default nobody
      // reads is not an allowlist.
      allow: ["opencode.ai"],
      deny: [],
    },
    mounts: {
      read: [
        ...getOpencodeBaseDirs(),
        getOcsRuntimeDir(),
        ...getSystemReadDirs(),
      ],
      // The agent can see how it was configured but not edit it: nothing in the
      // policy ever needs rewriting mid-session. See README, "Config tampering".
      write: [...getOpencodeBaseDirs(), ...getTempDirs()],
    },
    protected: {
      read: [...PROTECTED_READ_DEFAULTS],
      write: [],
    },
    srt: {
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowAppleEvents: false,
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      mandatoryDenySearchDepth: 3,
    },
  };
}
