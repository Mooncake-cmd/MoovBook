// Transforma um livro carregado em uma sequência de "quadros" (slides) do vídeo
// e sabe desenhar cada quadro num canvas.

import { paginate } from './layout/paginate.js';

export const FONT_FAMILIES = {
  literata: { label: 'Literata (livro)', css: '"Literata", Georgia, "Times New Roman", serif' },
  serif: { label: 'Georgia (serifada)', css: 'Georgia, "Times New Roman", serif' },
  sans: { label: 'Sem serifa', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif' },
  mono: { label: 'Monoespaçada', css: 'ui-monospace, Menlo, Consolas, "Liberation Mono", monospace' },
};

let measureCtx = null;
const measureCache = new Map();
function measure(text, font) {
  const key = `${font}\u0000${text}`;
  let w = measureCache.get(key);
  if (w === undefined) {
    if (!measureCtx) {
      const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : document.createElement('canvas');
      measureCtx = c.getContext('2d');
    }
    measureCtx.font = font;
    w = measureCtx.measureText(text).width;
    if (measureCache.size > 200000) measureCache.clear();
    measureCache.set(key, w);
  }
  return w;
}

export async function ensureFonts(family) {
  if (!document.fonts?.load) return;
  const css = FONT_FAMILIES[family]?.css || family;
  try {
    await Promise.all([
      document.fonts.load(`16px ${css}`),
      document.fonts.load(`bold 16px ${css}`),
      document.fonts.load(`italic 16px ${css}`),
      document.fonts.load(`italic bold 16px ${css}`),
    ]);
  } catch {
    /* sem fontes web: usa as do sistema */
  }
}

/**
 * @param {*} book
 * @param {{
 *  width:number, height:number, pagesPerFrame:1|2, fit:'contain'|'cover',
 *  background:string, pageColor:string, textColor:string,
 *  fontFamily:string, fontSize:number, lineHeight:number, margin:number, justify:boolean,
 *  pageNumbers:boolean,
 * }} s
 */
export function buildDocument(book, s) {
  const W = s.width;
  const H = s.height;
  const per = s.pagesPerFrame === 2 ? 2 : 1;
  const unit = Math.min(W, H) / 1080;

  let pageCount;
  let reflowPages = null;
  let layout = null;

  if (book.kind === 'reflow') {
    const pageW = W / per;
    const margin = (s.margin / 100) * Math.min(W, H);
    const fontSize = s.fontSize * unit;
    const footer = s.pageNumbers ? fontSize * 1.6 : 0;
    const box = { x: margin, y: margin, w: pageW - margin * 2, h: H - margin * 2 - footer };
    const family = FONT_FAMILIES[s.fontFamily]?.css || s.fontFamily;
    reflowPages = paginate(book.blocks, {
      width: box.w,
      height: box.h,
      fontSize,
      lineHeight: s.lineHeight,
      fontFamily: family,
      justify: s.justify,
      measure,
      getImage: (src) => book.images.get(src),
      maxImageScale: 2.5 * unit,
    });
    pageCount = reflowPages.length;
    layout = { pageW, box, fontSize, family };
  } else {
    pageCount = book.count;
  }

  const count = Math.ceil(pageCount / per);

  function slidePages(i) {
    const out = [];
    for (let k = 0; k < per; k++) {
      const p = i * per + k;
      if (p < pageCount) out.push(p);
    }
    return out;
  }

  async function drawSlide(ctx, i, pixelScale = 1) {
    const pages = slidePages(i);
    ctx.save();
    ctx.fillStyle = book.kind === 'reflow' ? s.pageColor : s.background;
    ctx.fillRect(0, 0, W, H);

    if (book.kind === 'reflow') {
      pages.forEach((p, k) => drawReflowPage(ctx, reflowPages[p], k * layout.pageW, p));
      if (per === 2) {
        // sombra sutil da "lombada" entre as duas páginas
        const gx = W / 2;
        const g = ctx.createLinearGradient(gx - 30 * unit, 0, gx + 30 * unit, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(0.5, 'rgba(0,0,0,0.12)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(gx - 30 * unit, 0, 60 * unit, H);
      }
    } else {
      const slotW = W / per;
      for (let k = 0; k < pages.length; k++) {
        const p = pages[k];
        const page = await book.getPage(p);
        const rect = fitRect(page.width, page.height, slotW, H, s.fit);
        // em pares, as páginas se encostam no centro como um livro aberto
        let x = k * slotW + rect.x;
        if (per === 2 && pages.length === 2) x = k === 0 ? slotW - rect.w : slotW;
        else if (per === 2 && pages.length === 1) x = (W - rect.w) / 2;
        ctx.save();
        ctx.beginPath();
        ctx.rect(per === 2 && pages.length === 2 ? k * slotW : 0, 0, per === 2 && pages.length === 2 ? slotW : W, H);
        ctx.clip();
        await page.draw(ctx, x, rect.y, rect.w, rect.h, pixelScale);
        ctx.restore();
        if (s.pageNumbers) drawPageBadge(ctx, p + 1, per === 2 && pages.length === 2 ? k * slotW + slotW / 2 : W / 2, H, unit);
      }
    }
    ctx.restore();
  }

  function drawReflowPage(ctx, page, offsetX, index) {
    const { box, fontSize, family } = layout;
    ctx.save();
    ctx.translate(offsetX + box.x, box.y);
    ctx.fillStyle = s.textColor;
    ctx.strokeStyle = s.textColor;
    ctx.textBaseline = 'alphabetic';
    let lastFont = '';
    for (const op of page.ops) {
      if (op.t === 'text') {
        if (op.font !== lastFont) {
          ctx.font = op.font;
          lastFont = op.font;
        }
        ctx.fillText(op.text, op.x, op.y);
      } else if (op.t === 'img') {
        const img = book.images.get(op.src);
        if (img) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img.bitmap, op.x, op.y, op.w, op.h);
        }
      } else if (op.t === 'line') {
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = Math.max(1, fontSize * 0.06);
        ctx.beginPath();
        ctx.moveTo(op.x1, op.y1);
        ctx.lineTo(op.x2, op.y2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
    if (s.pageNumbers) {
      ctx.save();
      ctx.fillStyle = s.textColor;
      ctx.globalAlpha = 0.55;
      ctx.font = `${fontSize * 0.7}px ${family}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(index + 1), offsetX + layout.pageW / 2, H - box.y * 0.6);
      ctx.restore();
    }
  }

  async function words(i) {
    let n = 0;
    for (const p of slidePages(i)) {
      if (reflowPages) n += reflowPages[p].words;
      else if (book.getWords) n += await book.getWords(p);
    }
    return n;
  }

  return { width: W, height: H, count, pageCount, perFrame: per, slidePages, drawSlide, words, hasWords: !!(reflowPages || book.getWords) };
}

function drawPageBadge(ctx, n, cx, H, unit) {
  const fs = 22 * unit;
  ctx.save();
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  const text = String(n);
  const w = ctx.measureText(text).width + fs * 1.2;
  const h = fs * 1.6;
  const x = cx - w / 2;
  const y = H - h - fs * 0.8;
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, h / 2) : ctx.rect(x, y, w, h);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, y + h / 2 + fs * 0.05);
  ctx.restore();
}

/** Calcula o retângulo de uma página dentro de uma área, em modo "conter" ou "preencher". */
export function fitRect(srcW, srcH, boxW, boxH, mode = 'contain') {
  const scale = mode === 'cover' ? Math.max(boxW / srcW, boxH / srcH) : Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}
