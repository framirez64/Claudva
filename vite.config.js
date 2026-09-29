import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base './' keeps asset and data paths relative, so the build also works
// from a GitHub Pages project path such as /aula/.
export default defineConfig({
  plugins: [react()],
  base: './',
});
