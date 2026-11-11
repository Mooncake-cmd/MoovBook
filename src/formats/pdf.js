// PDF via pdf.js — cada página do PDF é renderizada na resolução exata do vídeo.

import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { countWords } from '../layout/blocks.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

installHiddenTabFrameScheduler();

/**
 * O pdf.js desenha cada página em etapas e espera um requestAnimationFrame entre
 * elas. O navegador não entrega esses quadros a abas escondidas: com a aba em
 * segundo plano, a página nunca terminava de ser desenhada e a conversão parava.
 * Aqui, enquanto a aba estiver escondida, cada pedido de quadro também é
 * atendido por um MessageChannel (que o navegador não pausa). O que rodar
 * primeiro executa a etapa; com a aba visível nada muda.
 */
function installHiddenTabFrameScheduler() {
  if (window.__moovbookFrameScheduler) return;
  window.__moovbookFrameScheduler = true;
  const nativeRequest = window.requestAnimationFrame.bind(window);
  const nativeCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map(); // id -> { cb, nativeId }
  let nextId = 1;
  const channel = new MessageChannel();
  const run = (id) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    nativeCancel(job.nativeId);
    job.cb(performance.now());
  };
  channel.port1.onmessage = (e) => run(e.data);

  window.requestAnimationFrame = (cb) => {
    const id = nextId++;
    pending.set(id, { cb, nativeId: nativeRequest(() => run(id)) });
    if (document.hidden) channel.port2.postMessage(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const job = pending.get(id);
    if (!job) return;
    nativeCancel(job.nativeId);
    pending.delete(id);
  };
  // pedidos feitos antes de a aba sumir também precisam seguir
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) for (const id of pending.keys()) channel.port2.postMessage(id);
  });
}

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
