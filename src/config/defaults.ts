import * as path from "path";
import * as os from "os";
import { OcsConfig } from "./types.js";

export function getDefaultHostConfig(): OcsConfig {
  const home = os.homedir();
  return {
    network: {
      allow: [],
      deny: [],
    },
    mounts: {
      read: [
        path.join(home, ".config", "opencode"),
        path.join(home, ".local", "share", "opencode"),
        path.join(home, ".cache", "opencode"),
        path.join(home, ".local", "state", "opencode"),
        path.join(home, ".config", "ocs"),
        "/usr",
        "/etc",
        "/bin",
        "/lib",
        "/lib64",
        "/opt",
      ],
      write: [
        path.join(home, ".config", "opencode"),
        path.join(home, ".local", "share", "opencode"),
        path.join(home, ".cache", "opencode"),
        path.join(home, ".local", "state", "opencode"),
        "/tmp",
        "/var/tmp",
      ],
    },
    protected: {
      read: [
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
      ],
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
