// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
  site: 'https://aipdfedit.com',
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      include: ['pdf-lib', 'canvas-confetti']
    }
  }
});
