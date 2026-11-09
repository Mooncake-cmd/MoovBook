// Formatos de texto: TXT, Markdown, HTML e RTF.

import { decodeText, parseHtml, dataUrlToBlob, makeReflowBook } from './common.js';
import { domToBlocks, BlockBuilder } from '../layout/blocks.js';

/** Converte texto puro em blocos, detectando parágrafos quebrados a cada linha. */
export function textToBlocks(text) {
  const b = new BlockBuilder();
  const normalized = text.replace(/\r\n?/g, '\n');
  const pages = normalized.split('\f');
  pages.forEach((pageText, pi) => {
    if (pi > 0) b.push({ type: 'break' });
    const paras = pageText.split(/\n[ \t]*\n+/);
    // Se há linhas em branco separando parágrafos, as quebras simples são só
    // "quebra de linha do arquivo" (ex.: Projeto Gutenberg) e devem ser unidas.
    const joinLines = paras.length > 1;
    for (const para of paras) {
      if (!para.trim()) continue;
      const lines = joinLines ? [para.replace(/\s*\n\s*/g, ' ')] : para.split('\n');
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        b.text(t, {});
        // Linhas curtas em caixa alta ou "Capítulo X" viram títulos
        if (t.length < 60 && (/^(cap[ií]tulo|chapter|parte|part|livro|book)\b/i.test(t) || (t === t.toUpperCase() && /\p{L}/u.test(t) && t.length > 2))) {
          b.flush('h', { level: 2 });
        } else {
          b.flush('p');
        }
      }
    }
  });
  b.flush();
  return b.blocks;
}

export async function loadTxt(file) {
  const text = decodeText(await file.arrayBuffer());
  return makeReflowBook({ title: file.name.replace(/\.\w+$/, ''), format: 'TXT', blocks: textToBlocks(text), resolve: async () => null });
}

// --- Markdown (subconjunto comum) ---

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function mdInline(s) {
  return escapeHtml(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>')
    .replace(/(\*|_)(?=\S)(.+?)(?<=\S)\1/g, '<em>$2</em>');
}

export function markdownToHtml(md) {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;
  let inCode = false;
  const flushPara = () => {
    if (para.length) out.push(`<p>${mdInline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of lines) {
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      out.push(inCode ? '</pre>' : '<pre>');
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }
    let m;
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) {
      flushPara();
      flushList();
      out.push(`<h${m[1].length}>${mdInline(m[2])}</h${m[1].length}>`);
    } else if (/^(\*\s*){3,}$|^(-\s*){3,}$|^(_\s*){3,}$/.test(line.trim())) {
      flushPara();
      flushList();
      out.push('<hr>');
    } else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      flushPara();
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (list !== tag) {
        flushList();
        out.push(`<${tag}>`);
        list = tag;
      }
      out.push(`<li>${mdInline(m[2])}</li>`);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      flushPara();
      flushList();
      out.push(`<blockquote><p>${mdInline(m[1])}</p></blockquote>`);
    } else {
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  if (inCode) out.push('</pre>');
  return out.join('\n');
}

export async function loadMarkdown(file) {
  const html = markdownToHtml(decodeText(await file.arrayBuffer()));
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const { blocks } = domToBlocks(doc.body);
  return makeReflowBook({
    title: doc.querySelector('h1')?.textContent?.trim() || file.name.replace(/\.\w+$/, ''),
    format: 'Markdown',
    blocks,
    resolve: (src) => (src.startsWith('data:') ? dataUrlToBlob(src) : null),
  });
}

export async function loadHtml(file) {
  const doc = parseHtml(decodeText(await file.arrayBuffer()));
  const { blocks } = domToBlocks(doc.body || doc.documentElement);
  return makeReflowBook({
    title: doc.querySelector('title')?.textContent?.trim() || file.name.replace(/\.\w+$/, ''),
    format: 'HTML',
    blocks,
    resolve: async (src) => {
      if (src.startsWith('data:')) return dataUrlToBlob(src);
      if (/^https?:/.test(src)) {
        try {
          const r = await fetch(src, { mode: 'cors' });
          return r.ok ? r.blob() : null;
        } catch {
          return null;
        }
      }
      return null;
    },
  });
}

// --- RTF (extração de texto com negrito/itálico básicos) ---

export function rtfToBlocks(rtf) {
  const b = new BlockBuilder();
  const stack = [];
  let state = { bold: false, italic: false, skip: false, uc: 1 };
  let i = 0;
  let pendingSkip = 0;
  const DEST_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr', 'footnote', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'xmlnstbl', 'fldinst', 'object', 'filetbl', 'revtbl', 'pgdsctbl', 'mmathPr']);
  const emit = (t) => {
    if (state.skip) return;
    if (pendingSkip > 0) {
      const n = Math.min(pendingSkip, t.length);
      pendingSkip -= n;
      t = t.slice(n);
    }
    if (t) b.text(t, state);
  };
  while (i < rtf.length) {
    const ch = rtf[i];
    if (ch === '{') {
      stack.push(state);
      state = { ...state };
      i++;
    } else if (ch === '}') {
      state = stack.pop() || state;
      i++;
    } else if (ch === '\\') {
      const next = rtf[i + 1];
      if (next === '\\' || next === '{' || next === '}') {
        emit(next);
        i += 2;
      } else if (next === '*') {
        state.skip = true;
        i += 2;
      } else if (next === "'") {
        const code = parseInt(rtf.substr(i + 2, 2), 16);
        emit(new TextDecoder('windows-1252').decode(new Uint8Array([code])));
        i += 4;
      } else if (next === '~') {
        emit('\u00a0');
        i += 2;
      } else if (next === '\n' || next === '\r') {
        if (!state.skip) b.flush();
        i += 2;
      } else {
        const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
        if (!m) {
          i += 2;
          continue;
        }
        i += m[0].length;
        const word = m[1];
        const param = m[2] !== undefined ? Number(m[2]) : null;
        if (DEST_SKIP.has(word)) state.skip = true;
        else if (word === 'par' || word === 'sect') { if (!state.skip) b.flush(); }
        else if (word === 'line') emit('\u2028');
        else if (word === 'page') { if (!state.skip) b.push({ type: 'break' }); }
        else if (word === 'tab') emit(' ');
        else if (word === 'b') state.bold = param !== 0;
        else if (word === 'i') state.italic = param !== 0;
        else if (word === 'plain') { state.bold = false; state.italic = false; }
        else if (word === 'uc') state.uc = param ?? 1;
        else if (word === 'u' && param !== null) {
          emit(String.fromCharCode(param < 0 ? param + 65536 : param));
          pendingSkip = state.uc;
        } else if (word === 'emdash') emit('—');
        else if (word === 'endash') emit('–');
        else if (word === 'lquote') emit('‘');
        else if (word === 'rquote') emit('’');
        else if (word === 'ldblquote') emit('“');
        else if (word === 'rdblquote') emit('”');
        else if (word === 'bullet') emit('•');
      }
    } else if (ch === '\r' || ch === '\n') {
      i++;
    } else {
      let j = i;
      while (j < rtf.length && !'\\{}\r\n'.includes(rtf[j])) j++;
      emit(rtf.slice(i, j));
      i = j;
    }
  }
  b.flush();
  return b.blocks;
}

export async function loadRtf(file) {
  const text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
  return makeReflowBook({ title: file.name.replace(/\.\w+$/, ''), format: 'RTF', blocks: rtfToBlocks(text), resolve: async () => null });
}
