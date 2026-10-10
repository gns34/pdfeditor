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
    build: {
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/fabric')) {
              return 'vendor-fabric';
            }
            if (id.includes('node_modules/pdf-lib')) {
              return 'vendor-pdflib';
            }
          },
        },
      },
    },
  }
});


