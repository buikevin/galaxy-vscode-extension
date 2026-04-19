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
import { listRecentFrontendPreviewImages } from '../attachments/attachment-store';
import type { FrontendPreviewReviewContext } from '../shared/attachments';
import type { GalaxyConfig } from '../shared/config';
import type { AgentType } from '../shared/protocol';
import { createDriver } from './driver-factory';
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
  RuntimeMessage,
  TrackedFile,
} from '../shared/runtime';
import type { ToolResult } from '../tools/entities/file-tools';

const VISUAL_REVIEW_MAX_IMAGES = 3;

function buildVisualEvidenceLines(
  imageName: string,
  reviewContext?: FrontendPreviewReviewContext,
): string[] {
  if (!reviewContext) {
    return [`- ${imageName}`];
  }

  const lines = [
    `- ${imageName}`,
    `  viewport: ${reviewContext.viewportLabel} (${reviewContext.width}x${reviewContext.height})`,
    `  final URL: ${reviewContext.finalUrl}`,
  ];

  if (reviewContext.pageTitle?.trim()) {
    lines.push(`  title: ${reviewContext.pageTitle.trim()}`);
  }
  if (reviewContext.consoleMessages && reviewContext.consoleMessages.length > 0) {
    lines.push(
      `  console signals: ${reviewContext.consoleMessages.slice(0, 4).join(' | ')}`,
    );
  }
  if (reviewContext.pageErrors && reviewContext.pageErrors.length > 0) {
    lines.push(
      `  page errors: ${reviewContext.pageErrors.slice(0, 4).join(' | ')}`,
    );
  }
  if (reviewContext.failedRequests && reviewContext.failedRequests.length > 0) {
    lines.push(
      `  failed network: ${reviewContext.failedRequests.slice(0, 4).join(' | ')}`,
    );
  }

  return lines;
}

function buildReadOnlyReviewConfig(config: GalaxyConfig): GalaxyConfig {
  return Object.freeze({
    ...config,
    toolCapabilities: Object.freeze({
      readProject: false,
      editFiles: false,
      runCommands: false,
      webResearch: false,
      validation: false,
      review: false,
      vscodeNative: false,
      galaxyDesign: false,
    }),
    toolToggles: Object.freeze(
      Object.fromEntries(
        Object.keys(config.toolToggles).map((key) => [key, false]),
      ) as typeof config.toolToggles,
    ),
    extensionToolToggles: Object.freeze(
      Object.fromEntries(
        Object.keys(config.extensionToolToggles).map((key) => [key, false]),
      ),
    ),
  });
}

async function collectDriverReviewText(opts: {
  config: GalaxyConfig;
  agentType: AgentType;
  messages: readonly RuntimeMessage[];
}): Promise<RuntimeReviewResult> {
  const driver = createDriver(
    buildReadOnlyReviewConfig(opts.config),
    opts.agentType,
    false,
  );
  let reviewText = '';
  let errorMessage = '';

  await driver.chat(opts.messages, (chunk) => {
    if (chunk.type === 'text') {
      reviewText += chunk.delta;
      return;
    }

    if (chunk.type === 'error') {
      errorMessage = chunk.message;
    }
  });

  if (errorMessage || !reviewText.trim()) {
    return Object.freeze({
      success: false,
      review:
        errorMessage ||
        `Visual reviewer returned no content for ${opts.agentType}.`,
      filesReviewed: 0,
      hadCritical: false,
      hadWarnings: false,
      findings: Object.freeze([]),
    });
  }

  const findings = parseReviewFindings(reviewText);
  return Object.freeze({
    success: true,
    review: reviewText.trim(),
    filesReviewed: 0,
    hadCritical: reviewText.includes('[CRITICAL]'),
    hadWarnings: reviewText.includes('[WARNING]'),
    findings,
  });
}

function buildVisualReviewPrompt(opts: {
  sessionFiles: readonly TrackedFile[];
  validationSummary?: string;
  previewImages: ReadonlyArray<
    Readonly<{
      name: string;
      frontendPreviewContext?: FrontendPreviewReviewContext;
    }>
  >;
}): string {
  const changedFiles = opts.sessionFiles
    .map((tracked) => path.relative(process.cwd(), tracked.filePath))
    .slice(0, 16);
  const validationBlock = opts.validationSummary?.trim()
    ? `Validation summary before visual review:\n${opts.validationSummary.trim().slice(0, REVIEWER_MAX_VALIDATION_SUMMARY_CHARS)}\n\n`
    : '';

  return [
    'Review the attached frontend preview screenshots.',
    'Only report issues that are directly visible in the screenshots or clearly implied by the validation summary and FE diagnostics.',
    'Focus on layout breakage, overflow, missing content, spacing, hierarchy, readability, responsiveness problems across viewports, and broken visual states.',
    'Treat console errors, uncaught page errors, and failed requests as supporting evidence when they explain a visible FE problem.',
    'Do not speculate about hidden interactions or backend behavior.',
    'If you cannot map an issue to a source file, use a screenshot location like `frontend-preview:<image-name>`.',
    'Output format:',
    '- [CRITICAL] `location` - Clear description and how to fix',
    '- [WARNING] `location` - Clear description and suggestion',
    '- [INFO] `location` - General observation or improvement',
    '',
    validationBlock,
    changedFiles.length > 0
      ? `Recently changed files:\n${changedFiles.map((filePath) => `- ${filePath}`).join('\n')}`
      : 'Recently changed files: none captured.',
    '',
    `Attached screenshots and FE evidence:\n${opts.previewImages
      .flatMap((image) =>
        buildVisualEvidenceLines(image.name, image.frontendPreviewContext),
      )
      .join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function runVisualReview(opts: {
  workspacePath?: string;
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<RuntimeReviewResult | null> {
  if (!opts.workspacePath) {
    return null;
  }

  const previewImages = listRecentFrontendPreviewImages(
    opts.workspacePath,
    VISUAL_REVIEW_MAX_IMAGES,
  );
  if (previewImages.length === 0) {
    return null;
  }

  const visualReview = await collectDriverReviewText({
    config: opts.config,
    agentType: opts.agentType,
    messages: [
      Object.freeze({
        id: `visual-review-${Date.now()}`,
        role: 'user',
        content: buildVisualReviewPrompt({
          sessionFiles: opts.sessionFiles,
          validationSummary: opts.validationSummary,
          previewImages,
        }),
        images: Object.freeze(
          previewImages.map((image) => image.imagePath),
        ),
        timestamp: Date.now(),
      }),
    ],
  });

  return Object.freeze({
    ...visualReview,
    filesReviewed: previewImages.length,
  });
}

export function mergeReviewResults(opts: {
  codeReview: RuntimeReviewResult | null;
  visualReview: RuntimeReviewResult | null;
}): RuntimeReviewResult | null {
  if (!opts.codeReview && !opts.visualReview) {
    return null;
  }

  if (opts.codeReview && !opts.codeReview.success) {
    return opts.codeReview;
  }
  if (opts.visualReview && !opts.visualReview.success) {
    return opts.visualReview;
  }

  const sections: string[] = [];
  const findings: RuntimeReviewFinding[] = [];
  let filesReviewed = 0;

  if (opts.codeReview) {
    sections.push(`### Code Review\n${opts.codeReview.review.trim()}`);
    findings.push(...opts.codeReview.findings);
    filesReviewed += opts.codeReview.filesReviewed;
  }
  if (opts.visualReview) {
    sections.push(`### Visual Review\n${opts.visualReview.review.trim()}`);
    findings.push(...opts.visualReview.findings);
    filesReviewed += opts.visualReview.filesReviewed;
  }

  return Object.freeze({
    success: true,
    review: sections.join('\n\n').trim(),
    filesReviewed,
    hadCritical: findings.some((finding) => finding.severity === 'critical'),
    hadWarnings: findings.some((finding) => finding.severity === 'warning'),
    findings: Object.freeze(findings),
  });
}

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
export function parseReviewFindings(reviewText: string): readonly RuntimeReviewFinding[] {
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
  workspacePath?: string;
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<RuntimeReviewResult | null> {
  const [codeReview, visualReview] = await Promise.all([
    runReviewer(opts),
    runVisualReview(opts),
  ]);
  return mergeReviewResults({
    codeReview,
    visualReview,
  });
}

/**
 * Adapts the reviewer result into the generic tool result shape used by the runtime.
 *
 * @param opts Review inputs for the current session.
 * @returns Tool result wrapping the reviewer output.
 */
export async function runCodeReviewTool(opts: {
  workspacePath?: string;
  sessionFiles: readonly TrackedFile[];
  config: GalaxyConfig;
  agentType: AgentType;
  validationSummary?: string;
}): Promise<ToolResult> {
  const result = await runCodeReview(opts);
  if (!result) {
    return Object.freeze({
      success: false,
      content: '',
      error: 'No files or FE screenshots available for review in this session.',
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
      `Review completed for ${result.filesReviewed} input(s).`,
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

  const reviewLabel = result.review.includes('### Visual Review')
    ? 'Review'
    : 'Code Review';

  return [
    '---',
    `${reviewLabel} (${result.filesReviewed} inputs)`,
    '',
    statusLine,
    '',
    result.review,
  ].join('\n').trim();
}

export type { RuntimeReviewFinding as ReviewFinding, RuntimeReviewResult as ReviewResult } from '../shared/runtime';
