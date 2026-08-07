/**
 * config.ts — user-facing configuration for visual-spec.config.ts.
 */

/**
 * R-9.4 — where collaboration reads and writes. Omitting the whole block is how
 * collaboration stays off (R-9.19); local mode never consults it.
 */
export type CollaborationConfig = {
  /** Repository owner (user or org login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Branch Pull Requests are opened against. Defaults to `main`. */
  baseBranch?: string;
};

export type ResolvedCollaborationConfig = Required<CollaborationConfig>;

export type VisualSpecConfig = {
  surfacesDir?: string;
  collaboration?: CollaborationConfig;
};

export type ResolvedVisualSpecConfig = {
  surfacesDir: string;
  /** `null` when no collaboration block was configured. */
  collaboration: ResolvedCollaborationConfig | null;
};

export const DEFAULT_CONFIG = {
  surfacesDir: 'surfaces',
  baseBranch: 'main',
} as const;

export function defineConfig(config: VisualSpecConfig): VisualSpecConfig {
  return config;
}

export function resolveConfig(config: VisualSpecConfig = {}): ResolvedVisualSpecConfig {
  const collab = config.collaboration;
  return {
    surfacesDir: config.surfacesDir ?? DEFAULT_CONFIG.surfacesDir,
    collaboration: collab
      ? { owner: collab.owner, repo: collab.repo, baseBranch: collab.baseBranch ?? DEFAULT_CONFIG.baseBranch }
      : null,
  };
}
