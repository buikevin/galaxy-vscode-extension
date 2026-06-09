/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Validation summary helpers for the VS Code runtime.
 */

import { appendTelemetryEvent } from '../context/telemetry';
import type { FinalValidationResult, ValidationCommand, ValidationProfileId } from '../shared/validation';

const DEFAULT_VALIDATION_OUTPUT_PREVIEW_CHARS = 6000;

/**
 * Builds a bounded validation output preview that preserves the failure tail.
 *
 * Many test runners print passing tests first and the actionable compiler/runtime
 * error near the end. Head-only truncation hides the real failure, so this keeps
 * a small header plus a larger tail without assuming a language or framework.
 *
 * @param rawOutput Raw command output.
 * @param maxChars Maximum characters to return.
 * @returns Bounded diagnostic preview.
 */
export function formatValidationOutputPreview(
  rawOutput: string,
  maxChars = DEFAULT_VALIDATION_OUTPUT_PREVIEW_CHARS,
): string {
  const normalized = rawOutput.replace(/\r\n/g, '\n').trim();
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }

  const markerBudget = 96;
  const headChars = Math.max(400, Math.min(1200, Math.floor(maxChars * 0.22)));
  const tailChars = Math.max(400, maxChars - headChars - markerBudget);
  const omittedChars = Math.max(0, normalized.length - headChars - tailChars);

  return [
    normalized.slice(0, headChars).trimEnd(),
    `...[truncated ${omittedChars} chars; showing tail for diagnostics]...`,
    normalized.slice(-tailChars).trimStart(),
  ].join('\n');
}

/**
 * Builds a human-readable summary of how the validator chose project commands.
 *
 * @param workspacePath Absolute workspace root used for telemetry correlation.
 * @param profiles Validation profiles inferred for the workspace.
 * @param commands Project-level validation commands selected for execution.
 * @param usedFileSafetyNet Whether file-level fallback validation will also run.
 * @returns Multiline summary describing the selected validation strategy.
 */
export function buildValidationSelectionSummary(
  workspacePath: string,
  profiles: readonly ValidationProfileId[],
  commands: readonly ValidationCommand[],
  usedFileSafetyNet: boolean,
): string {
  const profileList = [...profiles].sort();
  appendTelemetryEvent(workspacePath, {
    kind: 'validation_selection',
    mode: commands.length > 0 ? 'project' : usedFileSafetyNet ? 'file' : 'none',
    profiles: Object.freeze(profileList),
    commandCount: commands.length,
    usedFileSafetyNet,
  });
  const byCategory = new Map<ValidationCommand['category'], ValidationCommand>();
  commands.forEach((command) => {
    if (!byCategory.has(command.category)) {byCategory.set(command.category, command);}
  });
  const lines = [`Selected validation profiles: ${profileList.length > 0 ? profileList.join(', ') : 'none'}`, 'Validation command selection:'];
  (['lint', 'static-check', 'test', 'build'] as const).forEach((category) => {
    const selected = byCategory.get(category);
    lines.push(`- ${category}: ${selected ? selected.command : 'none'}`);
  });
  lines.push(usedFileSafetyNet ? '- file-safety-net: enabled because no project-level static-check command was selected' : '- file-safety-net: disabled');
  return lines.join('\n');
}

/**
 * Formats the final validation result for prompt and transcript output.
 *
 * @param result Completed validation result that aggregates every executed run.
 * @returns Markdown-friendly validation summary text.
 */
export function formatValidationSummary(result: FinalValidationResult): string {
  const lines: string[] = ['---', `Validation (${result.mode})`, '', result.summary];
  result.runs.forEach((run) => {
    lines.push(`- ${run.success ? 'PASS' : 'FAIL'} [${run.profile}/${run.category}] \`${run.command}\``);
    run.issues
      .filter((issue) => issue.severity === 'warning')
      .forEach((issue) => {
        lines.push(`  - WARNING: ${issue.message}`);
      });
    if (!run.success && run.rawOutputPreview.trim()) {
      lines.push('', '```text', formatValidationOutputPreview(run.rawOutputPreview), '```');
    }
  });
  return lines.join('\n').trim();
}
