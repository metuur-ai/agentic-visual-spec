import { defineConfig } from '@visual-spec/core/config';

export default defineConfig({
  surfacesDir: 'surfaces',
  spec: {
    mode: 'openspec', // where apply-specs materializes: 'openspec' | 'lid-ears' | 'speckit'
    defaultDialect: 'ears', // the composer's initial form
  },
});
