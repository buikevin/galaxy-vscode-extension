export type ValidationProfileId =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'java'
  | 'go'
  | 'rust'
  | 'dotnet'
  | 'php'
  | 'shell'
  | 'ruby';

export type ValidationCommand = Readonly<{
  id: string;
  label: string;
  command: string;
  cwd: string;
  kind: 'project' | 'file';
  profile: ValidationProfileId | 'file';
  category: 'lint' | 'static-check' | 'test' | 'build' | 'file';
}>;

export type ValidationIssue = Readonly<{
  filePath?: string;
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
  message: string;
  source: string;
}>;

export type ValidationRunResult = Readonly<{
  success: boolean;
  commandId: string;
  command: string;
  profile: ValidationCommand['profile'];
  category: ValidationCommand['category'];
  durationMs: number;
  summary: string;
  issues: readonly ValidationIssue[];
  rawOutputPreview: string;
}>;

export type FinalValidationResult = Readonly<{
  success: boolean;
  mode: 'project' | 'file' | 'none';
  selectionSummary: string;
  runs: readonly ValidationRunResult[];
  summary: string;
}>;

export type ValidationCommandStreamCallbacks = Readonly<{
  onStart?: (payload: {
    toolCallId: string;
    commandText: string;
    cwd: string;
    startedAt: number;
  }) => void | Promise<void>;
  onChunk?: (payload: {
    toolCallId: string;
    chunk: string;
  }) => void | Promise<void>;
  onEnd?: (payload: {
    toolCallId: string;
    exitCode: number;
    success: boolean;
    durationMs: number;
  }) => void | Promise<void>;
}>;
