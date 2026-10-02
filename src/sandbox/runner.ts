export interface SandboxRunner {
  initialize(config: any): Promise<void>;
  wrapWithSandbox(command: string, options?: any): Promise<string>;
  reset(): Promise<void>;
  close(): Promise<void>;
}
