import { defineConfig } from 'vite';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Copia os recursos do pdf.js (fontes padrão, CMaps, wasm) para public/pdfjs,
// para que PDFs com fontes não embutidas ou asiáticas sejam renderizados.
function copyPdfjsAssets() {
  return {
    name: 'copy-pdfjs-assets',
    buildStart() {
      const src = resolve('node_modules/pdfjs-dist');
      const dest = resolve('public/pdfjs');
      mkdirSync(dest, { recursive: true });
      for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        if (existsSync(`${src}/${dir}`)) cpSync(`${src}/${dir}`, `${dest}/${dir}`, { recursive: true });
      }
    },
  };
}

export default defineConfig({
  // caminhos relativos: o site funciona em qualquer subpasta (ex.: GitHub Pages)
  base: './',
  plugins: [copyPdfjsAssets()],
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { environment: 'happy-dom' },
});
