// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://pdfeditx.com',

  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      include: ['pdf-lib', 'canvas-confetti'],
      // pdfjs-dist uses dynamic imports; exclude from pre-bundling to avoid issues
      exclude: ['pdfjs-dist'],
    },
  }
});


