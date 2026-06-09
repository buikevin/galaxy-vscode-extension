/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-05-09
 * @modify date 2026-05-09
 * @desc Lightweight file-scope claims used to detect unsafe cross-subagent edits.
 */

import fs from "node:fs";
import path from "node:path";
import { ensureProjectStorage, getProjectStorageInfo } from "./project-store";

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

export type FileScopeConflict = Readonly<{
  filePath: string;
  requestedRole: string;
  existingRole: string;
  existingOwner: string;
  reason: string;
}>;

export type FileScopeClaimResult = Readonly<{
  success: boolean;
  claimedFiles: readonly string[];
  conflicts: readonly FileScopeConflict[];
  content: string;
}>;

type FileScopeClaim = Readonly<{
  filePath: string;
  role: string;
  owner: string;
  reason: string;
  claimedAt: number;
  expiresAt: number;
}>;

type FileScopeWrite = Readonly<{
  filePath: string;
  role: string;
  toolName: string;
  writtenAt: number;
}>;

type FileScopeState = Readonly<{
  claims: readonly FileScopeClaim[];
  writes: readonly FileScopeWrite[];
}>;

function statePath(workspacePath: string): string {
  const info = getProjectStorageInfo(workspacePath);
  ensureProjectStorage(info);
  return path.join(info.projectDirPath, "file-scope-locks.json");
}

function normalizeFilePath(workspacePath: string, filePath: string): string {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(workspacePath, filePath);
  return path.relative(workspacePath, resolved) || path.basename(resolved);
}

function loadState(workspacePath: string): FileScopeState {
  try {
    const target = statePath(workspacePath);
    if (!fs.existsSync(target)) {
      return Object.freeze({ claims: Object.freeze([]), writes: Object.freeze([]) });
    }
    const parsed = JSON.parse(fs.readFileSync(target, "utf-8")) as Partial<FileScopeState>;
    const now = Date.now();
    return Object.freeze({
      claims: Object.freeze((parsed.claims ?? []).filter((claim) => claim.expiresAt > now)),
      writes: Object.freeze((parsed.writes ?? []).filter((write) => now - write.writtenAt <= LOCK_TTL_MS)),
    });
  } catch {
    return Object.freeze({ claims: Object.freeze([]), writes: Object.freeze([]) });
  }
}

function saveState(workspacePath: string, state: FileScopeState): void {
  fs.writeFileSync(statePath(workspacePath), JSON.stringify(state, null, 2), "utf-8");
}

function isCompatibleRoleTransition(existingRole: string, requestedRole: string): boolean {
  const implementationQualityRoles = new Set(["coding", "testing", "review"]);
  return implementationQualityRoles.has(existingRole) && implementationQualityRoles.has(requestedRole);
}

export function claimFileScope(opts: {
  workspacePath: string;
  files: readonly string[];
  role: string;
  owner?: string;
  reason?: string;
  force?: boolean;
}): FileScopeClaimResult {
  const state = loadState(opts.workspacePath);
  const now = Date.now();
  const role = opts.role || "main";
  const owner = opts.owner || role;
  const reason = opts.reason || "subagent file-scope claim";
  const normalizedFiles = [...new Set(opts.files.map((file) => normalizeFilePath(opts.workspacePath, file)).filter(Boolean))];
  const conflicts = normalizedFiles.flatMap((filePath) =>
    state.claims
      .filter((claim) =>
        claim.filePath === filePath &&
        claim.role !== role &&
        !isCompatibleRoleTransition(claim.role, role)
      )
      .map((claim): FileScopeConflict => Object.freeze({
        filePath,
        requestedRole: role,
        existingRole: claim.role,
        existingOwner: claim.owner,
        reason: claim.reason,
      })),
  );

  if (conflicts.length > 0 && !opts.force) {
    return formatClaimResult(false, [], conflicts);
  }

  const remainingClaims = state.claims.filter(
    (claim) => !normalizedFiles.includes(claim.filePath),
  );
  const nextClaims = normalizedFiles.map((filePath): FileScopeClaim => Object.freeze({
    filePath,
    role,
    owner,
    reason,
    claimedAt: now,
    expiresAt: now + LOCK_TTL_MS,
  }));
  saveState(opts.workspacePath, Object.freeze({
    claims: Object.freeze([...remainingClaims, ...nextClaims]),
    writes: state.writes,
  }));
  return formatClaimResult(true, normalizedFiles, conflicts);
}

export function recordSubagentFileEdit(opts: {
  workspacePath: string;
  filePath: string;
  role: string;
  toolName: string;
}): readonly FileScopeConflict[] {
  const state = loadState(opts.workspacePath);
  const normalizedPath = normalizeFilePath(opts.workspacePath, opts.filePath);
  const conflicts = [
    ...state.claims
      .filter((claim) =>
        claim.filePath === normalizedPath &&
        claim.role !== opts.role &&
        !isCompatibleRoleTransition(claim.role, opts.role)
      )
      .map((claim): FileScopeConflict => Object.freeze({
        filePath: normalizedPath,
        requestedRole: opts.role,
        existingRole: claim.role,
        existingOwner: claim.owner,
        reason: claim.reason,
      })),
    ...state.writes
      .filter((write) =>
        write.filePath === normalizedPath &&
        write.role !== opts.role &&
        !isCompatibleRoleTransition(write.role, opts.role)
      )
      .slice(-1)
      .map((write): FileScopeConflict => Object.freeze({
        filePath: normalizedPath,
        requestedRole: opts.role,
        existingRole: write.role,
        existingOwner: write.role,
        reason: `Previous ${write.role} edit via ${write.toolName}`,
      })),
  ];
  saveState(opts.workspacePath, Object.freeze({
    claims: state.claims,
    writes: Object.freeze([
      ...state.writes,
      Object.freeze({
        filePath: normalizedPath,
        role: opts.role,
        toolName: opts.toolName,
        writtenAt: Date.now(),
      }),
    ]),
  }));
  return Object.freeze(conflicts);
}

function formatClaimResult(
  success: boolean,
  claimedFiles: readonly string[],
  conflicts: readonly FileScopeConflict[],
): FileScopeClaimResult {
  return Object.freeze({
    success,
    claimedFiles: Object.freeze([...claimedFiles]),
    conflicts: Object.freeze([...conflicts]),
    content: [
      success ? "File scope claimed." : "File scope conflict detected.",
      claimedFiles.length > 0 ? `Claimed files:\n${claimedFiles.map((file) => `- ${file}`).join("\n")}` : "",
      conflicts.length > 0
        ? `Conflicts:\n${conflicts.map((conflict) => `- ${conflict.filePath}: ${conflict.existingRole} already owns this scope (${conflict.reason})`).join("\n")}`
        : "Conflicts: none",
    ].filter(Boolean).join("\n"),
  });
}
