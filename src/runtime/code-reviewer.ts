import fs from 'node:fs';
import path from 'node:path';
import type { GalaxyConfig } from '../config/types';
import type { AgentType, ChatMessage } from '../shared/protocol';
import type { ToolResult } from '../tools/file-tools';
import type { TrackedFile } from './session-tracker';
import { createDriver } from './driver-factory';

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer with 15+ years of experience across all programming languages.

Your job is to review code that was just written or modified, and provide clear, actionable feedback.

For each file, check for:
1. Logic errors and bugs
2. Missing edge cases
3. Security vulnerabilities
4. Type/runtime errors
5. Code quality
6. Cross-file consistency

Output format:
- [CRITICAL] \`filename:line\` - Clear description and how to fix
- [WARNING] \`filename:line\` - Clear description and suggestion
- [INFO] \`filename\` - General observation or improvement

At the end, write one of:
- ✅ LGTM
- ⚠️ Issues found - N critical, M warnings

Be specific and concise. Skip trivial style comments.
Respond in the same language as the code comments/strings.`;

const MAX_FILE_CHARS = 8_000;

export type ReviewFinding = Readonly<{
  severity: 'critical' | 'warning' | 'info';
  location: string;
  message: string;
}>;

export type ReviewResult = Readonly<{
  success: boolean;
  review: string;
  filesReviewed: number;
  hadCritical: boolean;
  hadWarnings: boolean;
  findings: readonly ReviewFinding[];
}>;

function buildReviewRequest(opts: {
  sessionFiles: readonly TrackedFile[];
  validationSummary?: string;
}): Readonly<{ userPrompt: string; fileCount: number; skipped: number }> | null {
  const fileSections: string[] = [];
  let skipped = 0;

  for (const tracked of opts.sessionFiles) {
    try {
      const raw = fs.readFileSync(tracked.filePath, 'utf-8');
      const content =
        raw.length > MAX_FILE_CHARS
          ? `${raw.slice(0, MAX_FILE_CHARS)}\n... [truncated ${raw.length - MAX_FILE_CHARS} chars]`
          : raw;
      const relPath = path.relative(process.cwd(), tracked.filePath);
      fileSections.push(
        `### ${relPath} (${tracked.language})\n\`\`\`${tracked.language.toLowerCase().split(' ')[0]}\n${content}\n\`\`\``,
      );
    } catch {
      skipped += 1;
    }
  }

  if (fileSections.length === 0) {
    return null;
  }

  const validationBlock = opts.validationSummary?.trim()
    ? `Validation summary before review:\n${opts.validationSummary.trim()}\n\n`
    : '';
  const userPrompt =
    `Please review the following ${fileSections.length} file(s) that were just written or modified.\n\n` +
    `${validationBlock}${fileSections.join('\n\n')}`;

  return Object.freeze({
    userPrompt,
    fileCount: fileSections.length,
    skipped,
  });
}

function parseReviewFindings(reviewText: string): readonly ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const pattern = /^- \[(CRITICAL|WARNING|INFO)\]\s+`([^`]+)`\s+-\s+(.+)$/gm;

  for (const match of reviewText.matchAll(pattern)) {
    const severity = String(match[1] ?? '').toLowerCase();
    if (severity !== 'critical' && severity !== 'warning' && severity !== 'info') {
      continue;
    }

    findings.push(
      Object.freeze({
        severity,
        location: String(match[2] ?? '').trim(),
        message: String(match[3] ?? '').trim(),
      }),
    );
  }

  return Object.freeze(findings);
}

async function runReviewer(opts: {
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<ReviewResult | null> {
  if (opts.sessionFiles.length === 0) {
    return null;
  }

  const reviewRequest = buildReviewRequest({
    sessionFiles: opts.sessionFiles,
    ...(opts.validationSummary ? { validationSummary: opts.validationSummary } : {}),
  });
  if (!reviewRequest) {
    return null;
  }

  const driver = createDriver(opts.config, opts.agentType, false);
  let reviewText = '';
  let hadError = false;
  let errorText = '';

  const reviewMessages: readonly ChatMessage[] = [
    {
      id: 'reviewer-system',
      role: 'user',
      content: REVIEWER_SYSTEM_PROMPT,
      timestamp: Date.now(),
    },
    {
      id: 'reviewer-request',
      role: 'user',
      content: reviewRequest.userPrompt,
      timestamp: Date.now(),
    },
  ];

  await driver.chat(reviewMessages, (chunk) => {
    if (chunk.type === 'text') {
      reviewText += chunk.delta;
      return;
    }

    if (chunk.type === 'error') {
      hadError = true;
      errorText = chunk.message;
    }
  });

  if (hadError || !reviewText.trim()) {
    return Object.freeze({
      success: false,
      review: errorText || 'Code Reviewer returned no content.',
      filesReviewed: reviewRequest.fileCount,
      hadCritical: false,
      hadWarnings: false,
      findings: Object.freeze([]),
    });
  }

  const findings = parseReviewFindings(reviewText);
  const hadCritical = reviewText.includes('[CRITICAL]');
  const hadWarnings = reviewText.includes('[WARNING]');

  return Object.freeze({
    success: true,
    review: reviewText.trim(),
    filesReviewed: reviewRequest.fileCount,
    hadCritical,
    hadWarnings,
    findings,
  });
}

export async function runCodeReview(opts: {
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<ReviewResult | null> {
  return runReviewer(opts);
}

export async function runCodeReviewTool(opts: {
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<ToolResult> {
  const result = await runReviewer(opts);
  if (!result) {
    return Object.freeze({
      success: false,
      content: '',
      error: 'No files available for code review in this session.',
    });
  }

  if (!result.success) {
    return Object.freeze({
      success: false,
      content: '',
      error: result.review,
    });
  }

  const statusLine = result.hadCritical
    ? 'Status: critical issues found'
    : result.hadWarnings
      ? 'Status: warnings found'
      : 'Status: LGTM';

  return Object.freeze({
    success: true,
    content: [
      `Code Reviewer completed for ${result.filesReviewed} file(s).`,
      statusLine,
      '',
      result.review,
    ].join('\n').trim(),
    meta: Object.freeze({
      findingsCount: result.findings.length,
      hadCritical: result.hadCritical,
      hadWarnings: result.hadWarnings,
    }),
  });
}

export function formatReviewSummary(result: ReviewResult): string {
  const statusLine = result.hadCritical
    ? 'Critical issues found'
    : result.hadWarnings
      ? 'Warnings found'
      : 'LGTM';

  return [
    '---',
    `Code Review (${result.filesReviewed} files)`,
    '',
    statusLine,
    '',
    result.review,
  ].join('\n').trim();
}
