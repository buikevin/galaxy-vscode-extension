import fs from 'node:fs';
import path from 'node:path';
import { Ollama } from 'ollama';
import type { GalaxyConfig } from '../config/types';
import type { AgentType } from '../shared/protocol';
import type { ToolResult } from '../tools/file-tools';
import type { TrackedFile } from './session-tracker';

const REVIEWER_SYSTEM_PROMPT = `You are a senior code reviewer with 15+ years of experience across all programming languages.

Your job is to review code that was just written or modified, and provide clear, actionable feedback.

Only report issues that are directly supported by the provided code and validation context.
If you are unsure, omit the issue instead of speculating.
Do not propose unnecessary rewrites when a smaller fix would be enough.

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

const MAX_FILE_CHARS = 6_000;
const MAX_REVIEW_BATCH_FILES = 4;
const MAX_REVIEW_REQUEST_CHARS = 18_000;
const MAX_VALIDATION_SUMMARY_CHARS = 2_500;
const REVIEWER_HOST = 'https://ollama.com';
const REVIEWER_MODEL = 'qwen3-coder-next:cloud';
const REVIEWER_API_KEY = '073a6aa5975f4cc5a68fe6c4a7f702f8.vhWYaW8O4o9JX-O-FLZatUGF';
const REVIEWER_KEEP_ALIVE = '10m';
const REVIEWER_OPTIONS = Object.freeze({
  temperature: 0.1,
  top_p: 0.85,
  repeat_penalty: 1.05,
  num_predict: 4096,
});

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

type ReviewMessage = Readonly<{
  role: 'system' | 'user';
  content: string;
}>;

type ReviewBatchRequest = Readonly<{
  userPrompt: string;
  fileCount: number;
  skipped: number;
  batchIndex: number;
  batchCount: number;
}>;

function buildReviewRequests(opts: {
  sessionFiles: readonly TrackedFile[];
  validationSummary?: string;
}): readonly ReviewBatchRequest[] {
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
    return Object.freeze([]);
  }

  const validationBlock = opts.validationSummary?.trim()
    ? `Validation summary before review:\n${opts.validationSummary.trim().slice(0, MAX_VALIDATION_SUMMARY_CHARS)}\n\n`
    : '';
  const sectionsByBatch: string[][] = [];
  let currentBatch: string[] = [];
  let currentChars = 0;

  for (const section of fileSections) {
    const wouldExceedBatchSize = currentBatch.length >= MAX_REVIEW_BATCH_FILES;
    const wouldExceedCharBudget = currentBatch.length > 0 && currentChars + section.length > MAX_REVIEW_REQUEST_CHARS;
    if (wouldExceedBatchSize || wouldExceedCharBudget) {
      sectionsByBatch.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(section);
    currentChars += section.length;
  }

  if (currentBatch.length > 0) {
    sectionsByBatch.push(currentBatch);
  }

  return Object.freeze(
    sectionsByBatch.map((sections, index): ReviewBatchRequest => {
      const prefix =
        sectionsByBatch.length > 1
          ? `Please review batch ${index + 1}/${sectionsByBatch.length} of recently modified files.\n\n`
          : `Please review the following ${sections.length} file(s) that were just written or modified.\n\n`;
      const prompt = `${prefix}${index === 0 ? validationBlock : ''}${sections.join('\n\n')}`;
      return Object.freeze({
        userPrompt: prompt,
        fileCount: sections.length,
        skipped: index === 0 ? skipped : 0,
        batchIndex: index + 1,
        batchCount: sectionsByBatch.length,
      });
    }),
  );
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

  const reviewRequests = buildReviewRequests({
    sessionFiles: opts.sessionFiles,
    ...(opts.validationSummary ? { validationSummary: opts.validationSummary } : {}),
  });
  if (reviewRequests.length === 0) {
    return null;
  }

  const client = new Ollama({
    host: REVIEWER_HOST,
    headers: { Authorization: `Bearer ${REVIEWER_API_KEY}` },
  });
  const reviewChunks: string[] = [];
  const findings: ReviewFinding[] = [];
  let filesReviewed = 0;

  for (const reviewRequest of reviewRequests) {
    let reviewText = '';
    let hadError = false;
    let errorText = '';

    const reviewMessages: readonly ReviewMessage[] = [
      {
        role: 'system',
        content: REVIEWER_SYSTEM_PROMPT,
      },
      {
        role: 'user',
        content: reviewRequest.userPrompt,
      },
    ];

    try {
      const stream = await client.chat({
        model: REVIEWER_MODEL,
        messages: reviewMessages.map((message) => ({
          role: message.role,
          content: message.content,
        })) as import('ollama').Message[],
        stream: true,
        think: false,
        keep_alive: REVIEWER_KEEP_ALIVE,
        options: REVIEWER_OPTIONS,
      });

      for await (const chunk of stream) {
        if (chunk.message?.content) {
          reviewText += chunk.message.content;
        }

        if (chunk.done && chunk.done_reason === 'load') {
          continue;
        }
      }
    } catch (error) {
      hadError = true;
      errorText = `Code Reviewer error: ${String(error)}`;
    }

    if (hadError || !reviewText.trim()) {
      return Object.freeze({
        success: false,
        review:
          errorText ||
          `Code Reviewer returned no content for batch ${reviewRequest.batchIndex}/${reviewRequest.batchCount}.`,
        filesReviewed,
        hadCritical: false,
        hadWarnings: false,
        findings: Object.freeze(findings),
      });
    }

    filesReviewed += reviewRequest.fileCount;
    reviewChunks.push(
      reviewRequests.length > 1
        ? `### Review batch ${reviewRequest.batchIndex}/${reviewRequest.batchCount}\n${reviewText.trim()}`
        : reviewText.trim(),
    );
    findings.push(...parseReviewFindings(reviewText));
  }

  const reviewText = reviewChunks.join('\n\n');
  const hadCritical = reviewText.includes('[CRITICAL]');
  const hadWarnings = reviewText.includes('[WARNING]');

  return Object.freeze({
    success: true,
    review: reviewText.trim(),
    filesReviewed,
    hadCritical,
    hadWarnings,
    findings: Object.freeze(findings),
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
