import { z } from "zod";

export const SrtKeys = [
  "allowAllUnixSockets",
  "allowLocalBinding",
  "allowAppleEvents",
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
  "mandatoryDenySearchDepth",
] as const;

export type SrtKey = (typeof SrtKeys)[number];

export const OcsConfigSchema = z.object({
  $schema: z.string().optional(),
  network: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([]),
    })
    .default({ allow: [], deny: [] }),
  mounts: z
    .object({
      read: z.array(z.string()).default([]),
      write: z.array(z.string()).default([]),
    })
    .default({ read: [], write: [] }),
  protected: z
    .object({
      read: z.array(z.string()).default([]),
      write: z.array(z.string()).default([]),
    })
    .default({ read: [], write: [] }),
  srt: z
    .object({
      allowAllUnixSockets: z.boolean().default(false),
      allowLocalBinding: z.boolean().default(false),
      allowAppleEvents: z.boolean().default(false),
      enableWeakerNestedSandbox: z.boolean().default(false),
      enableWeakerNetworkIsolation: z.boolean().default(false),
      mandatoryDenySearchDepth: z.number().int().default(3),
    })
    .partial()
    .optional(),
});

export type OcsConfig = z.infer<typeof OcsConfigSchema>;

export type ResolvedPath = {
  original: string;
  absolute: string;
  exists: boolean;
  resolvedAncestor?: string;
};

/**
 * Where an entry in the compiled policy came from.
 *
 * `cli` is a first-class origin rather than folded into `host`. `-m`/`-w`/`-n`
 * are exempt from the containment gate that untrusted project config goes
 * through, so a reviewer reading `--explain` needs to be able to see at a
 * glance which entries skipped that check and why they were allowed to.
 */
export type ProvenanceSource = "host" | "cli" | `project:${string}`;

export type ProvenanceEntry = {
  source: ProvenanceSource;
  value: unknown;
};

export type Provenance = {
  network: {
    allow: ProvenanceEntry[];
    deny: ProvenanceEntry[];
  };
  mounts: {
    read: ProvenanceEntry[];
    write: ProvenanceEntry[];
  };
  protected: {
    read: ProvenanceEntry[];
    write: ProvenanceEntry[];
  };
  srt: {
    [key: string]: ProvenanceEntry;
  };
};
