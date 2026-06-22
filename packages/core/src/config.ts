/**
 * config.ts — user-facing configuration for visual-spec.config.ts.
 */
export type VisualSpecConfig = {
  surfacesDir?: string;
};

export const DEFAULT_CONFIG = {
  surfacesDir: 'surfaces',
} satisfies Required<VisualSpecConfig>;

export function defineConfig(config: VisualSpecConfig): VisualSpecConfig {
  return config;
}

export function resolveConfig(config: VisualSpecConfig = {}): Required<VisualSpecConfig> {
  return {
    surfacesDir: config.surfacesDir ?? DEFAULT_CONFIG.surfacesDir,
  };
}
