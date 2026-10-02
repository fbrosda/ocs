import * as os from "os";
import * as path from "path";
import type {
  SandboxRuntimeConfig,
  WrapWithSandboxOptions,
} from "@anthropic-ai/sandbox-runtime";
import { SandboxRunner } from "./runner.js";
import { LibraryRunner } from "./library-runner.js";
import { OcsConfig } from "../config/types.js";
import { anchorReadDenyGlobs } from "../config/globs.js";
import { getDenyReadAnchors } from "../config/paths.js";
import { bindSeccompBinary } from "./seccomp.js";
import { validateCompiledPolicy } from "./validator.js";

/**
 * Compile an `ocs` policy into the object handed to the sandbox runtime.
 *
 * Two things happen here that the compiled output is relied on for:
 *
 * 1. Relative read-deny globs are anchored against known roots. This is what
 *    stops the built-in credential-glob defaults from silently denying nothing
 *    — see `src/config/globs.ts`.
 * 2. The result is validated. So `--print-config` shows exactly what would run,
 *    and a policy that could not be enforced is refused at compile time rather
 *    than at wrap time.
 */
export function buildSrtConfig(
  ocsConfig: OcsConfig,
  projectPath: string
): SandboxRuntimeConfig {
  const project = path.resolve(projectPath);
  const hatches = buildSrtEscapeHatches(ocsConfig);

  // The seccomp loader runs inside the sandbox, so it has to be bound in or
  // nothing runs at all — and the same path has to be named in the config, so
  // the file we bind is the file that gets executed. Throws rather than quietly
  // returning null when sockets are supposed to be blocked; see the module
  // comment in src/sandbox/seccomp.ts for why that case is not a warning.
  const seccompPath = bindSeccompBinary(ocsConfig);
  const seccompReads = seccompPath ? [seccompPath] : [];

  const config: SandboxRuntimeConfig = {
    filesystem: {
      // Deny the home directory wholesale, then re-open exactly what is needed
      // below. This is what turns "the agent can read your project" into "the
      // agent can read your project and nothing else of yours": on Linux a
      // denied directory re-opened by an allowRead entry comes back only as the
      // named path, not as the tree above it.
      denyRead: [
        os.homedir(),
        ...anchorReadDenyGlobs(
          ocsConfig.protected.read,
          getDenyReadAnchors(project)
        ),
      ],
      // The project is granted here rather than through the host defaults
      // because it is the one grant that comes from the command line and not
      // from a config file.
      allowRead: [project, ...seccompReads, ...ocsConfig.mounts.read],
      allowWrite: [project, ...ocsConfig.mounts.write],
      denyWrite: [...ocsConfig.protected.write],
    },
    network: {
      allowedDomains: [...ocsConfig.network.allow],
      deniedDomains: [...ocsConfig.network.deny],
      ...hatches.network,
    },
    ...(seccompPath ? { seccomp: { applyPath: seccompPath } } : {}),
    ...hatches.topLevel,
  };

  validateCompiledPolicy(config);

  return config;
}

/**
 * The settings that remove the sandbox rather than widen it, placed where `srt`
 * actually reads them.
 *
 * `ocs` groups these under one `srt` key because that is the right place for
 * them *in our config*: they are the keys a project config may never set, and
 * grouping them makes the permission gate one rule instead of six. It is not
 * where `srt` expects them — `allowAllUnixSockets` and `allowLocalBinding` live
 * under `network`, the other four at the top level. Spreading all six flat puts
 * two of them somewhere the config schema strips without a word, which turns
 * "allow unix sockets" into a no-op that still looks configured, and that
 * failure mode matters most for exactly the settings that remove confinement.
 *
 * Hence two buckets rather than one spread: spreading a single flat object
 * either drops the network allowlist on the floor or leaves two booleans
 * somewhere the schema silently strips them.
 */
function buildSrtEscapeHatches(ocsConfig: OcsConfig): {
  topLevel: Partial<SandboxRuntimeConfig>;
  network: Partial<SandboxRuntimeConfig["network"]>;
} {
  const srt = ocsConfig.srt;
  if (!srt) {
    return { topLevel: {}, network: {} };
  }

  const { allowAllUnixSockets, allowLocalBinding, ...topLevelSrt } = srt;
  const { mandatoryDenySearchDepth, ...booleanSrt } = topLevelSrt;

  return {
    topLevel: {
      ...(booleanSrt.enableWeakerNestedSandbox !== undefined && {
        enableWeakerNestedSandbox: booleanSrt.enableWeakerNestedSandbox,
      }),
      ...(booleanSrt.enableWeakerNetworkIsolation !== undefined && {
        enableWeakerNetworkIsolation: booleanSrt.enableWeakerNetworkIsolation,
      }),
      ...(booleanSrt.allowAppleEvents !== undefined && {
        allowAppleEvents: booleanSrt.allowAppleEvents,
      }),
      ...(mandatoryDenySearchDepth !== undefined && {
        mandatoryDenySearchDepth,
      }),
    },
    network: {
      ...(allowAllUnixSockets !== undefined && { allowAllUnixSockets }),
      ...(allowLocalBinding !== undefined && { allowLocalBinding }),
    },
  };
}

export class SandboxManager {
  private runner: SandboxRunner;

  constructor(runner?: SandboxRunner) {
    this.runner = runner ?? new LibraryRunner();
  }

  async initialize(ocsConfig: OcsConfig, projectPath: string): Promise<void> {
    await this.runner.initialize(buildSrtConfig(ocsConfig, projectPath));
  }

  async wrap(
    command: string,
    options?: WrapWithSandboxOptions
  ): Promise<string> {
    return this.runner.wrapWithSandbox(command, options);
  }

  /**
   * Patterns the runtime could not enforce on this platform, as srt itself
   * reports them.
   *
   * `srt` is the code that did the expansion, so asking it is strictly better
   * than re-deriving the same rules here — it is also the only way to catch
   * write-path globs, which take no globs at all on Linux. Returns `[]` on
   * macOS, where these patterns are matched natively.
   *
   * Only meaningful after `wrap()`, which is where the expansion happens.
   */
  unenforcedGlobWarnings(): Promise<string[]> {
    return this.runner.unenforcedGlobWarnings();
  }

  /**
   * Always call this. It tears down the network proxies and the socat bridge;
   * skipping it leaks processes, and a leak is invisible in tests and very
   * annoying in real use. See AGENTS.md invariant 6.
   */
  async reset(): Promise<void> {
    return this.runner.reset();
  }

  async close(): Promise<void> {
    return this.runner.close();
  }
}
