// Converte uma árvore DOM (HTML/XHTML) em uma lista simples de "blocos"
// que o motor de paginação entende:
//   { type: 'p',  runs: [{ text, bold, italic }], variant?: 'quote'|'pre'|'center' }
//   { type: 'h',  level: 1..6, runs: [...] }
//   { type: 'img', src: string }            (resolvido depois por um "resolver")
//   { type: 'hr' }
//   { type: 'break' }                        (quebra de página forçada)

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
  'blockquote', 'pre', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'figure', 'figcaption',
  'table', 'tr', 'td', 'th', 'thead', 'tbody', 'caption', 'address', 'center',
  'body', 'html', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br-block',
]);
const SKIP_TAGS = new Set(['head', 'script', 'style', 'noscript', 'template', 'title', 'meta', 'link', 'iframe', 'object', 'video', 'audio', 'math']);
const HEADING_RE = /^h([1-6])$/;
/** Caractere interno que representa uma quebra de linha forçada (<br>) */
export const LINE_BREAK = '\u2028';

export class BlockBuilder {
  constructor() {
    this.blocks = [];
    this.runs = [];
    this.variant = null;
  }

  text(text, style) {
    if (!text) return;
    const last = this.runs[this.runs.length - 1];
    if (last && last.bold === !!style.bold && last.italic === !!style.italic) {
      last.text += text;
    } else {
      this.runs.push({ text, bold: !!style.bold, italic: !!style.italic });
    }
  }

  flush(type = 'p', extra = {}) {
    const runs = normalizeRuns(this.runs, this.variant === 'pre');
    this.runs = [];
    if (!runs.length) return;
    const block = { type, runs, ...extra };
    if (type === 'p' && this.variant) block.variant = this.variant;
    this.blocks.push(block);
  }

  push(block) {
    this.flush();
    if (block.type === 'break') {
      const last = this.blocks[this.blocks.length - 1];
      if (!last || last.type === 'break') return; // evita páginas vazias
    }
    this.blocks.push(block);
  }
}

function normalizeRuns(runs, preserve) {
  if (preserve) {
    const out = runs.filter((r) => r.text.length);
    // remove quebras de linha nas pontas
    if (out.length) {
      out[0].text = out[0].text.replace(/^\n+/, '');
      out[out.length - 1].text = out[out.length - 1].text.replace(/\s+$/, '');
    }
    return out.filter((r) => r.text.length);
  }
  const out = [];
  let prevSpace = true;
  for (const r of runs) {
    let t = '';
    for (const ch of r.text) {
      if (ch === LINE_BREAK) { t = t.replace(/ $/, '') + '\n'; prevSpace = true; continue; }
      if (/\s/.test(ch) && ch !== ' ') {
        if (!prevSpace) { t += ' '; prevSpace = true; }
      } else {
        t += ch;
        prevSpace = false;
      }
    }
    if (t) out.push({ text: t, bold: r.bold, italic: r.italic });
  }
  // apara o fim
  while (out.length) {
    const last = out[out.length - 1];
    last.text = last.text.replace(/[ \t]+$/, '');
    if (last.text) break;
    out.pop();
  }
  return out;
}

/**
 * Percorre um nó DOM e acrescenta blocos ao builder.
 * @param {Node} root
 * @param {BlockBuilder} b
 */
export function domToBlocks(root, b = new BlockBuilder()) {
  walk(root, b, { bold: false, italic: false });
  b.flush();
  return b;
}

function walk(node, b, style) {
  if (node.nodeType === 3 /* TEXT */) {
    b.text(node.nodeValue, style);
    return;
  }
  if (node.nodeType === 9 /* DOCUMENT */) {
    for (const c of node.childNodes) walk(c, b, style);
    return;
  }
  if (node.nodeType !== 1 /* ELEMENT */) return;

  const tag = (node.localName || node.nodeName || '').toLowerCase();
  if (SKIP_TAGS.has(tag)) return;

  const st = styleOf(node);
  if (st.display === 'none' || node.hidden) return;

  if (node.hasAttribute && node.hasAttribute('data-pagebreak')) {
    b.push({ type: 'break' });
    return;
  }

  if (tag === 'br') {
    b.text(LINE_BREAK, style);
    return;
  }
  if (tag === 'hr') {
    b.push({ type: 'hr' });
    return;
  }
  if (tag === 'img' || tag === 'image') {
    const src = node.getAttribute('src') || node.getAttribute('href') || node.getAttribute('xlink:href') ||
      (node.getAttributeNS && node.getAttributeNS('http://www.w3.org/1999/xlink', 'href')) ||
      node.getAttribute('recindex') && `recindex:${node.getAttribute('recindex')}`;
    if (src) b.push({ type: 'img', src, alt: node.getAttribute('alt') || '' });
    return;
  }
  if (tag === 'svg') {
    // Só extrai imagens embutidas em SVG (comum em capas de EPUB)
    for (const img of node.querySelectorAll ? node.querySelectorAll('image') : []) walk(img, b, style);
    return;
  }
  if (tag === 'mbp:pagebreak' || tag === 'pagebreak') {
    b.push({ type: 'break' });
    // o parser HTML trata <mbp:pagebreak/> como tag aberta: o conteúdo seguinte vira "filho"
    for (const c of node.childNodes) walk(c, b, style);
    return;
  }

  const newStyle = {
    bold: style.bold || tag === 'b' || tag === 'strong' || tag === 'th' || /^(bold|[6-9]00)$/.test(st.fontWeight || ''),
    italic: style.italic || tag === 'i' || tag === 'em' || tag === 'cite' || tag === 'var' || st.fontStyle === 'italic',
  };

  const isBlock = BLOCK_TAGS.has(tag) || HEADING_RE.test(tag) || st.display === 'block';
  const heading = HEADING_RE.exec(tag);

  if (st.pageBreakBefore) b.push({ type: 'break' });

  if (isBlock) b.flush();

  const prevVariant = b.variant;
  if (tag === 'blockquote') b.variant = 'quote';
  else if (tag === 'pre') b.variant = 'pre';
  else if (tag === 'center' || st.textAlign === 'center') b.variant = b.variant === 'pre' ? 'pre' : 'center';

  if (tag === 'li') {
    const parent = node.parentNode;
    const ordered = parent && (parent.localName || '').toLowerCase() === 'ol';
    let prefix = '• ';
    if (ordered) {
      let n = 1;
      for (let s = node.previousElementSibling; s; s = s.previousElementSibling) n++;
      prefix = `${n}. `;
    }
    b.text(prefix, style);
  }

  if (heading) {
    for (const c of node.childNodes) walk(c, b, { bold: true, italic: newStyle.italic });
    b.flush('h', { level: Number(heading[1]) });
  } else {
    if (tag === 'pre') {
      for (const c of node.childNodes) walkPre(c, b, newStyle);
    } else {
      for (const c of node.childNodes) walk(c, b, newStyle);
    }
    if (isBlock) b.flush();
  }

  b.variant = prevVariant;
  if (st.pageBreakAfter) b.push({ type: 'break' });
}

function walkPre(node, b, style) {
  if (node.nodeType === 3) {
    b.text(node.nodeValue, style);
  } else if (node.nodeType === 1) {
    if ((node.localName || '').toLowerCase() === 'br') b.text('\n', style);
    else for (const c of node.childNodes) walkPre(c, b, style);
  }
}

// Leitura mínima de estilos inline (não temos o CSS completo do livro)
function styleOf(el) {
  const out = {};
  const s = el.getAttribute && el.getAttribute('style');
  if (s) {
    for (const decl of s.split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const k = decl.slice(0, i).trim().toLowerCase();
      const v = decl.slice(i + 1).trim().toLowerCase();
      if (k === 'display') out.display = v;
      else if (k === 'font-weight') out.fontWeight = v;
      else if (k === 'font-style') out.fontStyle = v;
      else if (k === 'text-align') out.textAlign = v;
      else if ((k === 'page-break-before' || k === 'break-before') && /always|page|left|right/.test(v)) out.pageBreakBefore = true;
      else if ((k === 'page-break-after' || k === 'break-after') && /always|page|left|right/.test(v)) out.pageBreakAfter = true;
    }
  }
  const align = el.getAttribute && el.getAttribute('align');
  if (align && align.toLowerCase() === 'center') out.textAlign = 'center';
  return out;
}

/** Conta palavras em uma lista de runs */
export function countWords(text) {
  const m = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}
