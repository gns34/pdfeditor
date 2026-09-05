// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://pdfeditx.com',
  integrations: [
    sitemap({
      customPages: [
        'https://pdfeditx.com/',
        'https://pdfeditx.com/edit',
        'https://pdfeditx.com/privacy',
      ],
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      include: ['pdf-lib', 'canvas-confetti'],
      // @hyzyla/pdfium bundles WASM and cannot be pre-bundled by Vite
      exclude: ['@hyzyla/pdfium'],
    },
    // Ensure .wasm files are served with correct MIME type
    assetsInclude: ['**/*.wasm'],
  }
});

