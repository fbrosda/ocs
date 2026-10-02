#!/usr/bin/env node
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createRequire } from "module";
import {
  applyHostConfig,
  CliGrants,
  loadJsonConfig,
  mergeConfigs,
  ConfigError,
} from "./config/merge.js";
import {
  getHomeConfigPath,
  getDefaultProjectConfig,
  normalizePath,
} from "./config/paths.js";
import { getDefaultHostConfig } from "./config/defaults.js";
import {
  checkOpencodeReachable,
  formatFindings,
  hasFailure,
} from "./preflight.js";

/**
 * The version, from `package.json` rather than a literal.
 *
 * Hardcoding it works exactly until the first release bump, at which point
 * `ocs --version` confidently reports a version that is not installed — and a
 * bug report quoting it is then worse than useless. Resolved relative to this
 * module so it is correct from `src/` under tsx, from `dist/`, and from a
 * global install.
 */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Single-quote one argument for the shell that ends up running the command.
 *
 * `srt` returns the wrapped command as a *string* and bwrap runs it via
 * `sh -c`, so an argument containing spaces or metacharacters has to be quoted
 * here or the sandboxed shell re-parses it as syntax.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command to run inside the sandbox: `opencode`, plus whatever followed
 * `--`.
 *
 * `command.args` is NOT that list. Commander puts the declared
 * `[project-path]` operand at index 0, so reading it directly made `ocs .`
 * try to run `.` — which the sandboxed shell reports as a missing filename.
 * The documented contract is "everything after `--`", so read that from argv,
 * and fall back to excess operands for anyone who omits the `--`.
 */
function resolveInnerCommand(command: Command, argv: string[]): string {
  const separator = argv.indexOf("--");
  const passthrough =
    separator === -1 ? command.args.slice(1) : argv.slice(separator + 1);
  if (passthrough.length === 0) {
    return "opencode";
  }
  return ["opencode", ...passthrough].map(shellQuote).join(" ");
}

interface RunOptions {
  mount?: string[];
  mountWrite?: string[];
  domain?: string[];
  config?: string;
  printConfig?: boolean;
  explain?: boolean;
  debug?: boolean;
}

const program = new Command();

program
  .name("ocs")
  .description("Run OpenCode inside an OS-level sandbox")
  .version(readPackageVersion())
  .argument("[project-path]", "Project path", process.cwd())
  .option(
    "-m, --mount <path>",
    "Extra read-only mount (trusted: skips containment)",
    (v, p) => p.concat(v),
    [] as string[]
  )
  .option(
    "-w, --mount-write <path>",
    "Extra writable mount (trusted: skips containment)",
    (v, p) => p.concat(v),
    [] as string[]
  )
  .option(
    "-n, --domain <domain>",
    "Allowed domain (trusted: skips containment)",
    (v, p) => p.concat(v),
    [] as string[]
  )
  .option("-c, --config <path>", "Alternate project config file")
  .option(
    "--print-config",
    "Print the compiled sandbox policy and exit. Runs no sandbox."
  )
  .option(
    "--explain",
    "With --print-config, annotate each entry with its origin"
  )
  .option("--debug", "Set SRT_DEBUG=1 for the sandbox runtime")
  .allowUnknownOption(true)
  .allowExcessArguments(true)
  .action(
    async (projectPathArg: string, options: RunOptions, command: Command) => {
      // Anything that is not a clean exit from here must reset the runtime; see
      // the finally below. Leaking the proxy here is the single easiest mistake
      // to make and the hardest to notice.
      const { SandboxManager, buildSrtConfig } =
        await import("./sandbox/manager.js");
      let manager: InstanceType<typeof SandboxManager> | undefined;

      try {
        const projectPath = normalizePath(projectPathArg);
        if (
          !fs.existsSync(projectPath) ||
          !fs.statSync(projectPath).isDirectory()
        ) {
          console.error(
            `Project path does not exist or is not a directory: ${projectPath}`
          );
          process.exit(1);
        }

        // Additively, per key — see applyHostConfig below for why a shallow
        // spread was quietly deleting the built-in credential protection.
        const hostConfig = applyHostConfig(
          getDefaultHostConfig(),
          loadJsonConfig(getHomeConfigPath())
        );
        const projectConfigPath =
          options.config ?? getDefaultProjectConfig(projectPath);
        const projectConfig = loadJsonConfig(projectConfigPath);

        // `-m`/`-w`/`-n` are a separate trusted channel rather than extra project
        // config. Folding them into the project file is what made
        // `ocs -m ~/.npm/_cacache .` fail: they were being run through the
        // containment gate that exists precisely because project config is
        // untrusted, and the user typed these.
        const cliGrants: CliGrants = {
          network: { allow: options.domain ?? [] },
          mounts: {
            read: options.mount ?? [],
            write: options.mountWrite ?? [],
          },
        };

        const { config, provenance } = await mergeConfigs(
          hostConfig,
          projectConfig,
          projectPath,
          cliGrants
        );

        if (options.printConfig) {
          // Print what would actually be handed to the runtime, not the
          // intermediate ocs policy. The two differ in ways that matter: globs are
          // anchored, `srt.*` keys are relocated, and paths are absolute.
          const srtConfig = buildSrtConfig(config, projectPath);
          console.log(
            JSON.stringify(
              options.explain ? { config: srtConfig, provenance } : srtConfig,
              null,
              2
            )
          );
          process.exit(0);
        }

        // Refuse before starting anything, not after. `opencode` is the command
        // being sandboxed, so if the policy cannot read it the run ends in a
        // bare `127` that points at the wrong thing entirely. Failing here costs
        // one PATH lookup and names the actual fix.
        const unreachable = checkOpencodeReachable(config, projectPath);
        if (hasFailure(unreachable)) {
          throw new ConfigError(
            `Refusing to start: ${unreachable.length} problem(s) with the command this sandbox exists to run.\n\n` +
              `${formatFindings(unreachable)}\n\n` +
              "`ocs doctor` runs the same checks and nothing else, so it is safe to run while\n" +
              "you are still setting the machine up."
          );
        }

        if (options.debug) {
          process.env.SRT_DEBUG = "1";
        }

        manager = new SandboxManager();

        // chdir before initialize(), not just before wrap(). The mandatory-deny
        // ripgrep scan and relative path expansion both resolve against the
        // process directory, and doing this after initialize() would scan
        // whatever directory ocs happened to be launched from.
        process.chdir(projectPath);
        await manager.initialize(config, projectPath);

        const wrapped = await manager.wrap(
          resolveInnerCommand(command, process.argv)
        );

        // Last chance to notice the runtime could not enforce part of the policy.
        // This has to happen before the spawn: the failure mode is a deny that
        // looks configured and protects nothing, so running anyway would mean
        // shipping a session quieter about its own limits than the user expects.
        const unenforced = await manager.unenforcedGlobWarnings();
        if (unenforced.length > 0) {
          throw new Error(
            `Refusing to start: the sandbox could not enforce ${unenforced.length} policy pattern(s) on this platform.\n` +
              unenforced.map((w) => `  ${w}`).join("\n") +
              "\n\nThese are patterns the runtime expands or matches differently on this platform, so a deny\n" +
              "you have configured would silently not apply. Rewrite each one with a literal directory\n" +
              "to start from, or remove it if you did not mean it as a security boundary.\n" +
              "Set SRT_DEBUG=1 (or pass --debug) for the expansion detail."
          );
        }

        const { spawn } = await import("child_process");
        const child = spawn("sh", ["-c", wrapped], {
          stdio: "inherit",
          cwd: projectPath,
        });

        // Spelled as a parameter type rather than `NodeJS.Signals`: the namespace
        // is a type-only global that eslint's `no-undef` still flags here, and the
        // signal type is whatever `kill` accepts anyway.
        const forward = (signal: Parameters<typeof child.kill>[0]) => () =>
          child.kill(signal);
        process.on("SIGINT", forward("SIGINT"));
        process.on("SIGTERM", forward("SIGTERM"));

        const code = await new Promise<number>((resolve) => {
          child.on("exit", (exitCode, signal) => {
            // 128+n is the shell convention for "killed by signal n", and it
            // preserves the distinction between a command that failed and one
            // that was killed. Defaulting a null code to 0 here would turn
            // Ctrl-C into a success.
            resolve(
              signal
                ? 128 + (os.constants.signals[signal] ?? 0)
                : (exitCode ?? 1)
            );
          });
          child.on("error", (err) => {
            console.error(`Failed to start sandboxed command: ${err.message}`);
            resolve(1);
          });
        });

        process.exitCode = code;
      } catch (e: unknown) {
        if (e instanceof ConfigError) {
          console.error(`Error: ${e.message}`);
        } else {
          console.error(e instanceof Error ? e.message : e);
        }
        process.exitCode = 1;
      } finally {
        // Invariant 6: reset on every exit path. This is also what tears down the
        // socat bridge, so skipping it leaves processes behind on the host.
        await manager?.reset();
      }
    }
  );

program
  .command("init")
  .description("Write a starting host config to ~/.config/ocs/config.json")
  .action(() => {
    const homeConfigPath = getHomeConfigPath();

    if (fs.existsSync(homeConfigPath)) {
      console.log(`Config already exists: ${homeConfigPath}`);
      console.log("Edit it directly; ocs init will not overwrite it.");
      return;
    }

    // The built-in zero-config providers are already in here; inference adds to
    // them rather than replacing them. The four defaults are the ones a new user
    // reaches anyway, and `opencode auth login` handles their credentials, so
    // seeding them here means the file works before anyone edits it.
    const config = getDefaultHostConfig();
    const inferred = inferProviderDomains().filter(
      (d) => !config.network.allow.includes(d)
    );

    if (inferred.length > 0) {
      config.network.allow = [...config.network.allow, ...inferred].sort();
      console.log(
        "Inferred additional network allow from your existing opencode config:"
      );
      for (const domain of inferred) {
        console.log(`  ${domain}`);
      }
      console.log(
        "Review these — an allowlist that is too wide is the whole risk this tool manages."
      );
    } else {
      console.log(
        "No additional provider domains found in ~/.config/opencode/opencode.json."
      );
    }

    console.log(
      "\nSeeded with the providers that work with no setup (opencode auth login). Delete"
    );
    console.log(
      "any you do not use, or add the hosts you need — this list is yours to edit."
    );

    fs.writeFileSync(homeConfigPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`\nCreated ${homeConfigPath}`);
  });

program
  .command("doctor")
  .description("Check that this machine can actually run the sandbox")
  .argument("[project-path]", "Project to judge opencode reachability against")
  .action(async (projectPathArg: string | undefined) => {
    // Imported lazily with the rest of the sandbox machinery, so `--print-config`
    // and `--help` never load the runtime. This one does load it — resolving the
    // pinned version is the point.
    const { runDoctor } = await import("./doctor.js");
    const report = await runDoctor(projectPathArg);

    console.log(
      `ocs doctor — ${os.platform()}/${os.arch()}, node ${process.version}\n`
    );
    console.log(formatFindings(report.findings));
    console.log(
      report.ok
        ? "\nNothing missing. `ocs init` writes the host config; `ocs <project>` runs the sandbox."
        : "\nSomething required is missing. Nothing above is optional."
    );
    process.exitCode = report.ok ? 0 : 1;
  });

/**
 * Best-effort guess at which model endpoints the user already reaches, read
 * from the opencode config rather than asked for, so a fresh install works.
 *
 * Only reads the host's own opencode config, and only its provider keys — a
 * project's opencode.json is not consulted, because at this point there is no
 * project and, more to the point, anything read out of a repository would be
 * exactly the kind of untrusted input the rest of this program refuses.
 */
function inferProviderDomains(): string[] {
  const opencodeConfigPath = path.join(
    os.homedir(),
    ".config",
    "opencode",
    "opencode.json"
  );

  if (!fs.existsSync(opencodeConfigPath)) {
    return [];
  }

  try {
    const raw = JSON.parse(fs.readFileSync(opencodeConfigPath, "utf-8")) as {
      provider?: Record<string, unknown>;
    };
    const providers = Object.keys(raw.provider ?? {});

    const domains = new Set<string>();
    for (const provider of providers) {
      // The npm names are the identifiers; anything else is a self-hosted or
      // custom endpoint whose host we cannot know without reading its config.
      const known: Record<string, string[]> = {
        anthropic: ["api.anthropic.com"],
        openai: ["api.openai.com"],
        openrouter: ["openrouter.ai"],
        google: ["generativelanguage.googleapis.com"],
        "google-vertex": ["aiplatform.googleapis.com"],
        github: [
          "api.github.com",
          "models.github.ai",
          "models.inference.ai.azure.com",
        ],
        azure: [],
        deepseek: ["api.deepseek.com"],
        mistral: ["api.mistral.ai"],
        groq: ["api.groq.com"],
        xai: ["api.x.ai"],
        togetherai: ["api.together.xyz"],
        fireworks: ["api.fireworks.ai"],
        cerebras: ["api.cerebras.ai"],
        perplexity: ["api.perplexity.ai"],
      };
      for (const domain of known[provider] ?? []) {
        domains.add(domain);
      }
      if (provider in known && known[provider].length === 0) {
        console.log(
          `  (skipping ${provider}: it needs an explicit host in network.allow)`
        );
      }
    }

    return [...domains].sort();
  } catch {
    return [];
  }
}

program.parse(process.argv);
