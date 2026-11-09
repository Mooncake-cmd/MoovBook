// FictionBook 2 (.fb2) — formato XML muito usado em bibliotecas digitais.

import { parseXml, byTag, base64ToBlob, decodeText } from './common.js';
import { domToBlocks } from '../layout/blocks.js';
import { makeReflowBook } from './common.js';

export async function loadFb2(bytes, fileName, onProgress) {
  const u8 = new Uint8Array(bytes);
  const head = new TextDecoder('ascii').decode(u8.subarray(0, 200));
  const enc = /encoding=["']([\w-]+)["']/i.exec(head)?.[1];
  const xml = parseXml(decodeText(u8, enc));
  if (!xml) throw new Error('FB2 inválido: XML corrompido.');

  const binaries = new Map();
  for (const bin of byTag(xml, 'binary')) {
    binaries.set(bin.getAttribute('id'), { type: bin.getAttribute('content-type') || 'image/jpeg', data: bin.textContent });
  }

  const title = byTag(xml, 'book-title')[0]?.textContent?.trim() || fileName.replace(/\.fb2(\.zip)?$/i, '');
  const out = document.implementation.createHTMLDocument('');
  const body = out.body;

  // Capa
  const cover = byTag(xml, 'coverpage')[0];
  const coverImg = cover && byTag(cover, 'image')[0];
  if (coverImg) {
    appendImage(coverImg, body);
    pageBreak(body);
  }

  function hrefOf(el) {
    return el.getAttribute('l:href') || el.getAttribute('xlink:href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || el.getAttribute('href') || '';
  }
  function appendImage(el, parent) {
    const img = out.createElement('img');
    img.setAttribute('src', `fb2:${hrefOf(el).replace(/^#/, '')}`);
    parent.appendChild(img);
  }
  function pageBreak(parent) {
    const d = out.createElement('div');
    d.setAttribute('data-pagebreak', '');
    parent.appendChild(d);
  }

  const MAP = {
    p: 'p', v: 'p', 'text-author': 'p', subtitle: 'h4', emphasis: 'em', strong: 'strong',
    epigraph: 'blockquote', cite: 'blockquote', poem: 'div', stanza: 'div', a: 'span',
    strikethrough: 'span', sub: 'span', sup: 'span', code: 'code', table: 'table', tr: 'tr', td: 'td', th: 'th',
  };

  function convert(node, parent, depth) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        parent.appendChild(out.createTextNode(c.nodeValue));
        continue;
      }
      if (c.nodeType !== 1) continue;
      const name = c.localName;
      if (name === 'section') {
        if (depth === 0) pageBreak(parent);
        const div = out.createElement('div');
        parent.appendChild(div);
        convert(c, div, depth + 1);
      } else if (name === 'title') {
        const h = out.createElement(`h${Math.min(6, depth + 1)}`);
        // títulos do FB2 contêm <p>s: viram linhas do título
        const ps = byTag(c, 'p');
        ps.forEach((p, i) => {
          if (i) h.appendChild(out.createElement('br'));
          h.appendChild(out.createTextNode(p.textContent));
        });
        if (!ps.length) h.textContent = c.textContent;
        parent.appendChild(h);
      } else if (name === 'image') {
        appendImage(c, parent);
      } else if (name === 'empty-line') {
        parent.appendChild(out.createElement('br'));
      } else if (name === 'annotation' || name === 'binary' || name === 'description') {
        continue;
      } else {
        const el = out.createElement(MAP[name] || 'span');
        parent.appendChild(el);
        convert(c, el, depth);
      }
    }
  }

  // Ignora corpos de notas (<body name="notes">)
  for (const b of byTag(xml, 'body')) {
    if (b.getAttribute('name') === 'notes' || b.getAttribute('name') === 'comments') continue;
    convert(b, body, 0);
  }
  onProgress?.(0.4);

  const { blocks } = domToBlocks(body);
  return makeReflowBook({
    title,
    format: 'FB2',
    blocks,
    resolve: async (src) => {
      const bin = binaries.get(src.replace(/^fb2:/, ''));
      return bin ? base64ToBlob(bin.data, bin.type) : null;
    },
    onProgress: (p) => onProgress?.(0.4 + 0.6 * p),
  });
}
