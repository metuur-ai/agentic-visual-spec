import react from '@vitejs/plugin-react';
import { visualSpec } from '@visual-spec/core/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // loc-tags runs enforce:'pre', so surfaces are tagged before plugin-react.
  plugins: [react(), ...visualSpec()],
  server: { port: 5180 },
});
