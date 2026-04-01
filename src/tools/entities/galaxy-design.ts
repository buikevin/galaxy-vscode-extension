/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Shared entities for Galaxy Design registry inspection and action planning.
 */

export type GalaxyDesignFramework =
  | 'react'
  | 'nextjs'
  | 'vue'
  | 'nuxtjs'
  | 'angular'
  | 'react-native'
  | 'flutter';

export type GalaxyDesignRunner = 'bun' | 'pnpm' | 'yarn' | 'npm';

export type GalaxyDesignCanonicalFramework =
  | 'react'
  | 'vue'
  | 'angular'
  | 'react-native'
  | 'flutter';

export type RegistryComponent = Readonly<{
  /** Optional human-readable registry display name. */
  name?: string;
  /** Registry component type identifier. */
  type?: string;
  /** Short description shown in registry responses. */
  description?: string;
  /** Files generated or referenced by this component. */
  files?: readonly string[];
  /** Runtime dependencies required by the component. */
  dependencies?: readonly string[];
  /** Dev-only dependencies required by the component. */
  devDependencies?: readonly string[];
  /** Peer dependencies expected from the host project. */
  peerDependencies?: readonly string[];
  /** Registry-level component dependencies. */
  registryDependencies?: readonly string[];
  /** Optional registry category label. */
  category?: string;
  /** Optional prop descriptors returned by the registry. */
  props?: readonly Readonly<Record<string, unknown>>[];
}>;

export type RegistryGroup = Readonly<{
  /** Optional human-readable group name. */
  name?: string;
  /** Optional group description. */
  description?: string;
  /** Component ids that belong to the group. */
  components?: readonly string[];
}>;

export type GalaxyDesignRegistry = Readonly<{
  /** Optional registry JSON schema reference. */
  $schema?: string;
  /** Registry name. */
  name?: string;
  /** Registry version string. */
  version?: string;
  /** Registry platform identifier. */
  platform?: string;
  /** Components keyed by registry id. */
  components: Readonly<Record<string, RegistryComponent>>;
  /** Groups keyed by registry id. */
  groups: Readonly<Record<string, RegistryGroup>>;
}>;

export type GalaxyDesignPackageManagerSource =
  | 'package-json'
  | 'bun-lock'
  | 'pnpm-lock'
  | 'yarn-lock'
  | 'npm-lock'
  | 'fallback';

export type GalaxyDesignProjectInfo = Readonly<{
  /** Absolute target project path being inspected. */
  targetPath: string;
  /** Detected framework, or unknown when detection fails. */
  framework: GalaxyDesignFramework | 'unknown';
  /** Package manager selected for Galaxy Design commands. */
  packageManager: GalaxyDesignRunner;
  /** Source used to infer the package manager. */
  packageManagerSource: GalaxyDesignPackageManagerSource;
  /** Whether components.json already exists in the target project. */
  galaxyDesignInitialized: boolean;
  /** Optional components.json path when initialization has already happened. */
  componentsConfigPath?: string;
  /** Canonical framework used to select the registry file. */
  registryFramework?: GalaxyDesignCanonicalFramework;
}>;

export type GalaxyDesignActionPlan = Readonly<{
  /** Action that will be executed by the tool. */
  action: 'init' | 'add';
  /** Absolute target project path. */
  targetPath: string;
  /** Detected project framework. */
  framework: GalaxyDesignFramework;
  /** Canonical registry framework used by the action. */
  registryFramework: GalaxyDesignCanonicalFramework;
  /** Package manager configured for the target project. */
  packageManager: GalaxyDesignRunner;
  /** Actual runner selected on the current machine. */
  runnerPackageManager: GalaxyDesignRunner;
  /** Source used to infer the package manager. */
  packageManagerSource: GalaxyDesignPackageManagerSource;
  /** Whether components.json already exists before execution. */
  componentsConfigExists: boolean;
  /** Executable that should be launched. */
  executable: string;
  /** Executable arguments for the action. */
  args: readonly string[];
  /** Shell-safe preview string shown to the user. */
  commandPreview: string;
  /** Components requested for add operations. */
  components: readonly string[];
}>;
