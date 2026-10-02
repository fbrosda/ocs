import { z } from "zod";

export const SrtKeys = [
  "allowAllUnixSockets",
  "allowLocalBinding",
  "allowAppleEvents",
  "enableWeakerNestedSandbox",
  "enableWeakerNetworkIsolation",
  "mandatoryDenySearchDepth",
] as const;

export type SrtKey = typeof SrtKeys[number];

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

export type ProvenanceEntry = {
  source: "host" | `project:${string}`;
  value: any;
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
