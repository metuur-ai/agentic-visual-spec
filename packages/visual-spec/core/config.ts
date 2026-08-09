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

/**
 * R-6.3 — whether the browser may change the checked-out branch of the served
 * repository. Off unless this says otherwise: it is the first browser-initiated
 * change to the user's own checkout, and read-only is the posture every other route
 * in this chain holds.
 */
export type GitConfig = {
  /** Expose `GET /__vs/git/branches` and `POST /__vs/git/checkout`. Defaults to false. */
  allowCheckout?: boolean;
};

export type ResolvedGitConfig = Required<GitConfig>;

export type VisualSpecConfig = {
  surfacesDir?: string;
  collaboration?: CollaborationConfig;
  git?: GitConfig;
};

export type ResolvedVisualSpecConfig = {
  surfacesDir: string;
  /** `null` when no collaboration block was configured. */
  collaboration: ResolvedCollaborationConfig | null;
  /**
   * Always present, unlike `collaboration`. The difference is deliberate: an absent
   * collaboration block means "no repository to talk to", which is a state the
   * routes report; an absent `git` block means the flag is false, which is a value.
   */
  git: ResolvedGitConfig;
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
    // `=== true` rather than `??` or a truthiness test: a config read from a file can
    // carry `'false'`, `0` or `'no'`, and every one of those is a request to leave
    // this off that a truthiness test would grant.
    git: { allowCheckout: config.git?.allowCheckout === true },
  };
}
