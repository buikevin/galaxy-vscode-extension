/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Constants for Galaxy Design registry lookup and CLI execution.
 */

import path from 'node:path';
import type { GalaxyDesignCanonicalFramework } from '../entities/galaxy-design';

/** Pinned Galaxy Design package version used by local tooling. */
export const GALAXY_DESIGN_VERSION = '0.2.71';
/** UNPKG base URL for published Galaxy Design registry artifacts. */
export const GALAXY_DESIGN_UNPKG_BASE = `https://unpkg.com/galaxy-design@${GALAXY_DESIGN_VERSION}/dist`;
/** Package spec passed to bunx/pnpm dlx/yarn dlx/npx. */
export const GALAXY_DESIGN_TOOL_PACKAGE_SPEC = `galaxy-design@${GALAXY_DESIGN_VERSION}`;
/** Local fallback directory that contains prebuilt registry JSON files. */
export const GALAXY_DESIGN_LOCAL_REGISTRY_DIR = path.resolve(__dirname, '../../../galaxy-design-cli/dist');

/** Maps canonical framework ids to registry file names. */
export const GALAXY_DESIGN_REGISTRY_FILE_BY_FRAMEWORK: Readonly<Record<GalaxyDesignCanonicalFramework, string>> = Object.freeze({
  react: 'registry-react.json',
  vue: 'registry-vue.json',
  angular: 'registry-angular.json',
  'react-native': 'registry-react-native.json',
  flutter: 'registry-flutter.json',
});
