// Motor de paginação: transforma blocos (texto/imagens) em páginas prontas
// para serem desenhadas num canvas. É puro (sem DOM) para poder ser testado:
// a medição de texto e o acesso às imagens são injetados via `opts`.

import { countWords } from './blocks.js';

const HEADING_SCALE = [1.75, 1.45, 1.25, 1.12, 1.05, 1];
const MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';

/**
 * @typedef {{t:'text', x:number, y:number, text:string, font:string}
 *         | {t:'img', x:number, y:number, w:number, h:number, src:string}
 *         | {t:'line', x1:number, y1:number, x2:number, y2:number}} Op
 * @typedef {{ ops: Op[], words: number }} Page
 *
 * @param {Array} blocks
 * @param {{
 *   width:number, height:number, fontSize:number, lineHeight:number,
 *   fontFamily:string, justify?:boolean,
 *   measure:(text:string, font:string)=>number,
 *   getImage:(src:string)=>({width:number,height:number}|null),
 *   maxImageScale?:number,
 * }} opts
 * @returns {Page[]}
 */
export function paginate(blocks, opts) {
  const W = opts.width;
  const H = opts.height;
  const fs = opts.fontSize;
  const lh = opts.lineHeight || 1.45;
  const maxImageScale = opts.maxImageScale ?? 2;

  const pages = [];
  let page = newPage();
  let y = 0;

  function newPage() {
    return { ops: [], words: 0 };
  }
  function breakPage() {
    if (page.ops.length) pages.push(page);
    page = newPage();
    y = 0;
  }
  function fontFor(run, size, family, forceBold) {
    return `${run.italic ? 'italic ' : ''}${run.bold || forceBold ? 'bold ' : ''}${Math.round(size * 100) / 100}px ${family}`;
  }

  for (const block of blocks) {
    switch (block.type) {
      case 'break':
        breakPage();
        break;

      case 'hr': {
        const gap = fs * 0.9;
        if (y + gap * 2 > H) breakPage();
        if (y > 0) {
          y += gap;
          page.ops.push({ t: 'line', x1: W * 0.35, y1: y, x2: W * 0.65, y2: y });
          y += gap;
        }
        break;
      }

      case 'img': {
        const img = opts.getImage(block.src);
        if (!img || !img.width || !img.height) break;
        let scale = Math.min(W / img.width, H / img.height, maxImageScale);
        let w = img.width * scale;
        let h = img.height * scale;
        const spacing = y > 0 ? fs * 0.5 : 0;
        const remaining = H - y - spacing;
        if (h > remaining) {
          // Encolhe para caber no resto da página se não perder muito; senão, nova página
          const shrink = remaining / h;
          if (remaining >= H * 0.35 && shrink >= 0.6) {
            w *= shrink;
            h *= shrink;
          } else {
            breakPage();
          }
        }
        if (y > 0) y += fs * 0.5;
        page.ops.push({ t: 'img', x: (W - w) / 2, y, w, h, src: block.src });
        y += h + fs * 0.5;
        break;
      }

      case 'h':
      case 'p': {
        const isHeading = block.type === 'h';
        const variant = block.variant;
        const size = isHeading ? fs * HEADING_SCALE[(block.level || 1) - 1] : fs;
        const family = variant === 'pre' ? MONO : opts.fontFamily;
        const lineH = size * lh;
        const indent = variant === 'quote' ? fs * 1.5 : 0;
        const maxW = W - indent * 2;
        const align = isHeading ? (block.level <= 2 ? 'center' : 'left') : variant === 'center' ? 'center' : (opts.justify && variant !== 'pre' ? 'justify' : 'left');
        const effSize = variant === 'pre' ? size * 0.85 : size;

        const lines = breakLines(block.runs, maxW, (run) => fontFor(run, effSize, family, isHeading), opts.measure, variant === 'pre');
        if (!lines.length) break;

        const spaceBefore = isHeading ? size * 0.9 : 0;
        const spaceAfter = isHeading ? size * 0.55 : fs * 0.55;

        if (isHeading) {
          // Mantém o título junto de pelo menos duas linhas do texto seguinte
          const needed = spaceBefore + lines.length * lineH + 2 * fs * lh;
          if (y > 0 && y + needed > H) breakPage();
          if (y > 0) y += spaceBefore;
        }

        lines.forEach((line, li) => {
          if (y + lineH > H + 0.01 && page.ops.length) breakPage();
          const baseline = y + lineH * 0.5 + effSize * 0.35;
          let x = indent;
          let extraPerSpace = 0;
          if (align === 'center') x += (maxW - line.width) / 2;
          else if (align === 'justify' && !line.hardEnd && li < lines.length - 1 && line.spaces > 0) {
            const extra = maxW - line.width;
            // Não estica linhas muito curtas
            if (extra < maxW * 0.3) extraPerSpace = extra / line.spaces;
          }
          for (const tok of line.tokens) {
            if (tok.space) {
              x += tok.w + extraPerSpace;
              continue;
            }
            page.ops.push({ t: 'text', x, y: baseline, text: tok.text, font: tok.font });
            x += tok.w;
          }
          page.words += countWords(line.tokens.map((t) => t.text).join(''));
          y += lineH;
        });
        y += spaceAfter;
        break;
      }
      default:
        break;
    }
  }
  if (page.ops.length) pages.push(page);

  // Páginas que contêm apenas uma imagem ficam centralizadas verticalmente
  for (const p of pages) {
    if (p.ops.length === 1 && p.ops[0].t === 'img') p.ops[0].y = (H - p.ops[0].h) / 2;
  }
  return pages;
}

/**
 * Quebra uma lista de runs em linhas que cabem em `maxW`.
 * Retorna [{ tokens:[{text,font,w,space}], width, spaces, hardEnd }]
 */
export function breakLines(runs, maxW, fontOf, measure, preserve = false) {
  // 1) tokens
  const tokens = [];
  for (const run of runs) {
    const font = fontOf(run);
    const text = preserve ? run.text.replace(/\t/g, '    ') : run.text;
    const parts = text.split(preserve ? /(\n| )/ : /(\n|\s+)/);
    for (const part of parts) {
      if (!part) continue;
      if (part === '\n') tokens.push({ newline: true });
      else if (/^\s+$/.test(part)) tokens.push({ text: preserve ? part : ' ', font, w: measure(preserve ? part : ' ', font), space: true });
      else tokens.push({ text: part, font, w: measure(part, font), space: false });
    }
  }

  // 2) linhas
  const lines = [];
  let cur = { tokens: [], width: 0, spaces: 0, hardEnd: false };
  const finish = (hard) => {
    // remove espaços no final
    while (cur.tokens.length && cur.tokens[cur.tokens.length - 1].space && !preserve) {
      cur.width -= cur.tokens.pop().w;
    }
    cur.spaces = cur.tokens.filter((t, i) => t.space && i > 0).length;
    cur.hardEnd = hard;
    if (cur.tokens.length || hard) lines.push(cur);
    cur = { tokens: [], width: 0, spaces: 0, hardEnd: false };
  };

  for (const tok of tokens) {
    if (tok.newline) {
      finish(true);
      continue;
    }
    if (tok.space) {
      if (!cur.tokens.length && !preserve) continue; // sem espaço no início da linha
      cur.tokens.push(tok);
      cur.width += tok.w;
      continue;
    }
    if (cur.width + tok.w <= maxW + 0.01) {
      cur.tokens.push(tok);
      cur.width += tok.w;
      continue;
    }
    // Palavra não cabe na linha atual: um "pedaço de palavra" sem espaço antes
    // (ex.: run em negrito colado) deve acompanhar a palavra anterior.
    if (cur.tokens.length) {
      const last = cur.tokens[cur.tokens.length - 1];
      const carry = [];
      if (!last.space) {
        // move os fragmentos colados para a próxima linha, se houver um espaço antes deles
        let i = cur.tokens.length - 1;
        while (i >= 0 && !cur.tokens[i].space) i--;
        if (i >= 0) {
          carry.push(...cur.tokens.splice(i + 1));
          cur.width = cur.tokens.reduce((s, t) => s + t.w, 0);
        }
      }
      finish(false);
      for (const c of carry) {
        cur.tokens.push(c);
        cur.width += c.w;
      }
    }
    if (cur.width + tok.w <= maxW + 0.01) {
      cur.tokens.push(tok);
      cur.width += tok.w;
      continue;
    }
    // Palavra maior que a linha inteira: quebra por caracteres
    let chunk = '';
    for (const ch of tok.text) {
      const w = measure(chunk + ch, tok.font);
      if (cur.width + w > maxW && (chunk || cur.tokens.length)) {
        if (chunk) {
          const cw = measure(chunk, tok.font);
          cur.tokens.push({ text: chunk, font: tok.font, w: cw, space: false });
          cur.width += cw;
        }
        finish(false);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    if (chunk) {
      const cw = measure(chunk, tok.font);
      cur.tokens.push({ text: chunk, font: tok.font, w: cw, space: false });
      cur.width += cw;
    }
  }
  finish(false);
  // remove linha vazia final gerada por quebra forçada no fim
  while (lines.length && !lines[lines.length - 1].tokens.length) lines.pop();
  return lines;
}
