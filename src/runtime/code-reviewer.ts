/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Run the dedicated hosted reviewer over files changed in the current session and format the result for Galaxy.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Ollama } from 'ollama';
import type { GalaxyConfig } from '../shared/config';
import type { AgentType } from '../shared/protocol';
import {
  REVIEWER_API_KEY,
  REVIEWER_HOST,
  REVIEWER_KEEP_ALIVE,
  REVIEWER_MAX_BATCH_FILES,
  REVIEWER_MAX_FILE_CHARS,
  REVIEWER_MAX_REQUEST_CHARS,
  REVIEWER_SYSTEM_PROMPT,
  REVIEWER_MAX_VALIDATION_SUMMARY_CHARS,
  REVIEWER_MODEL,
  REVIEWER_OPTIONS,
} from '../shared/constants';
import type {
  ReviewBatchRequest,
  ReviewMessage,
  RuntimeReviewFinding,
  RuntimeReviewResult,
  TrackedFile,
} from '../shared/runtime';
import type { ToolResult } from '../tools/entities/file-tools';

/**
 * Builds reviewer prompt batches from the files changed in the current session.
 *
 * @param opts Session files and optional validation summary.
 * @returns Prompt batches sized for the hosted reviewer model.
 */
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
        raw.length > REVIEWER_MAX_FILE_CHARS
          ? `${raw.slice(0, REVIEWER_MAX_FILE_CHARS)}\n... [truncated ${raw.length - REVIEWER_MAX_FILE_CHARS} chars]`
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
    ? `Validation summary before review:\n${opts.validationSummary.trim().slice(0, REVIEWER_MAX_VALIDATION_SUMMARY_CHARS)}\n\n`
    : '';
  const sectionsByBatch: string[][] = [];
  let currentBatch: string[] = [];
  let currentChars = 0;

  for (const section of fileSections) {
    const wouldExceedBatchSize = currentBatch.length >= REVIEWER_MAX_BATCH_FILES;
    const wouldExceedCharBudget = currentBatch.length > 0 && currentChars + section.length > REVIEWER_MAX_REQUEST_CHARS;
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

/**
 * Parses structured findings from the reviewer markdown output.
 *
 * @param reviewText Raw reviewer response text.
 * @returns Structured review findings derived from the response.
 */
function parseReviewFindings(reviewText: string): readonly RuntimeReviewFinding[] {
  const findings: RuntimeReviewFinding[] = [];
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

/**
 * Executes the hosted reviewer for the files changed in the current session.
 *
 * @param opts Session files, config, agent metadata, and optional validation summary.
 * @returns Structured review result, or `null` when there are no files to review.
 */
async function runReviewer(opts: {
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<RuntimeReviewResult | null> {
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
  const findings: RuntimeReviewFinding[] = [];
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

/**
 * Runs the hosted reviewer and returns its structured result.
 *
 * @param opts Review inputs for the current session.
 * @returns Structured review result or `null` when nothing can be reviewed.
 */
export async function runCodeReview(opts: {
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<RuntimeReviewResult | null> {
  return runReviewer(opts);
}

/**
 * Adapts the reviewer result into the generic tool result shape used by the runtime.
 *
 * @param opts Review inputs for the current session.
 * @returns Tool result wrapping the reviewer output.
 */
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

/**
 * Formats one review result into the summary block displayed in the UI.
 *
 * @param result Structured review result returned by the reviewer.
 * @returns User-facing markdown summary.
 */
export function formatReviewSummary(result: RuntimeReviewResult): string {
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

export type { RuntimeReviewFinding as ReviewFinding, RuntimeReviewResult as ReviewResult } from '../shared/runtime';
