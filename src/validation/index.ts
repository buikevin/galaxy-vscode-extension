/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Public validation entrypoint for the VS Code runtime.
 */

export { parseIssuesWithCwd } from './issues';
export {
  buildNodeExecCommand,
  buildNodeScriptCommand,
  detectNodePackageManager,
  hasDirectory,
  hasFile,
  parsePackageDependencyNames,
  parsePackageScripts,
  selectNodeValidationScripts,
} from './node';
export { detectValidationProfiles } from './profiles';
export { detectProjectCommands } from './command-detection';
export { buildValidationSelectionSummary, formatValidationSummary } from './summary';
export { runFinalValidation } from './project-validator';
