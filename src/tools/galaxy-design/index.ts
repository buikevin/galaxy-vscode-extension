/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-01
 * @modify date 2026-04-01
 * @desc Entry-point exports for Galaxy Design tooling modules in the VS Code runtime.
 */

export type {
  GalaxyDesignActionPlan,
  GalaxyDesignCanonicalFramework,
  GalaxyDesignFramework,
  GalaxyDesignProjectInfo,
  GalaxyDesignRegistry,
  GalaxyDesignRunner,
  RegistryComponent,
  RegistryGroup,
} from '../entities/galaxy-design';
export { getGalaxyDesignProjectInfo, prepareGalaxyDesignAction } from './core';
export { galaxyDesignRegistryTool } from './registry';
export { galaxyDesignAddTool, galaxyDesignInitTool, galaxyDesignProjectInfoTool } from './execute';
