// PDF via pdf.js — cada página do PDF é renderizada na resolução exata do vídeo.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { countWords } from '../layout/blocks.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// URL absoluta: o worker do pdf.js resolve caminhos relativos a partir de si mesmo
const ASSETS = new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

export async function loadPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl: `${ASSETS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${ASSETS}standard_fonts/`,
    wasmUrl: `${ASSETS}wasm/`,
    iccUrl: `${ASSETS}iccs/`,
  }).promise;

  let title = file.name.replace(/\.pdf$/i, '');
  try {
    const meta = await doc.getMetadata();
    if (meta?.info?.Title && String(meta.info.Title).trim()) title = String(meta.info.Title).trim();
  } catch {
    /* sem metadados */
  }

  const wordCache = new Map();

  return {
    kind: 'fixed',
    format: 'PDF',
    title,
    count: doc.numPages,
    async getPage(i) {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      return {
        width: vp.width,
        height: vp.height,
        async draw(ctx, x, y, w, h, pixelScale = 1) {
          const tw = Math.max(1, Math.round(w * pixelScale));
          const th = Math.max(1, Math.round(h * pixelScale));
          const viewport = page.getViewport({ scale: tw / vp.width });
          const canvas = document.createElement('canvas');
          canvas.width = tw;
          canvas.height = th;
          const c = canvas.getContext('2d');
          c.fillStyle = '#fff';
          c.fillRect(0, 0, tw, th);
          await page.render({ canvas, canvasContext: c, viewport }).promise;
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(canvas, x, y, w, h);
          canvas.width = canvas.height = 0; // libera memória
        },
      };
    },
    async getWords(i) {
      if (wordCache.has(i)) return wordCache.get(i);
      const page = await doc.getPage(i + 1);
      const tc = await page.getTextContent();
      const n = countWords(tc.items.map((it) => it.str || '').join(' '));
      wordCache.set(i, n);
      return n;
    },
    destroy() {
      doc.destroy();
    },
  };
}
