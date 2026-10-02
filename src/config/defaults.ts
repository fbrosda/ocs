import { OcsConfig } from "./types.js";
import {
  getOcsRuntimeDir,
  getOpencodeBaseDirs,
  getSystemReadDirs,
  getTempDirs,
} from "./paths.js";

/**
 * Credential filenames worth denying wherever they turn up.
 *
 * These are relative double-star patterns on purpose: `buildSrtConfig` anchors
 * them against the project and opencode's state directories at compile time,
 * which is what makes them enforceable on Linux at all. Do not "fix" these to
 * be absolute-by-hand for one project — that would leave every other project
 * uncovered. See `src/config/globs.ts` for why this shape is load-bearing.
 *
 * `.npmrc` and `.git-credentials` are here because they routinely hold live
 * registry and Git credentials *and* sit inside project directories, which is
 * the one place a deny has to win against an allow.
 */
const PROTECTED_READ_DEFAULTS = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.p12",
  "**/*.key",
  "**/id_rsa*",
  "**/id_ed25519*",
  "**/.netrc",
  "**/.npmrc",
  "**/.git-credentials",
  "**/.htpasswd",
  "**/credentials.json",
  "**/service-account*.json",
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
      allow: [],
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
