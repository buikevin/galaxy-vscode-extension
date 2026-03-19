export type ValidationCommand = Readonly<{
  id: string;
  label: string;
  command: string;
  cwd: string;
  kind: 'project' | 'file';
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
  category: ValidationCommand['category'];
  durationMs: number;
  summary: string;
  issues: readonly ValidationIssue[];
  rawOutputPreview: string;
}>;

export type FinalValidationResult = Readonly<{
  success: boolean;
  mode: 'project' | 'file' | 'none';
  runs: readonly ValidationRunResult[];
  summary: string;
}>;
