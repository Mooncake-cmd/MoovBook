// Documentos de escritório: DOCX (Word) e ODT (LibreOffice/OpenOffice).

import { zipFile, parseXml, byTag, mimeFromName, makeReflowBook, dataUrlToBlob, resolvePath } from './common.js';
import { domToBlocks } from '../layout/blocks.js';

export async function loadDocx(file, onProgress) {
  const { default: mammoth } = await import('mammoth/mammoth.browser.js');
  const result = await mammoth.convertToHtml(
    { arrayBuffer: await file.arrayBuffer() },
    { styleMap: ['p[style-name=\'Title\'] => h1:fresh', 'p[style-name=\'Subtitle\'] => h2:fresh'] },
  );
  onProgress?.(0.5);
  const doc = new DOMParser().parseFromString(`<body>${result.value}</body>`, 'text/html');
  const { blocks } = domToBlocks(doc.body);
  const title = doc.querySelector('h1')?.textContent?.trim() || file.name.replace(/\.docx$/i, '');
  return makeReflowBook({
    title,
    format: 'DOCX',
    blocks,
    resolve: (src) => (src.startsWith('data:') ? dataUrlToBlob(src) : null),
    onProgress: (p) => onProgress?.(0.5 + p * 0.5),
  });
}

const NS_TEXT = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';

export async function loadOdt(zip, fileName, onProgress) {
  const contentFile = zipFile(zip, 'content.xml');
  if (!contentFile) throw new Error('ODT inválido: content.xml não encontrado.');
  const xml = parseXml(await contentFile.async('string'));
  if (!xml) throw new Error('ODT inválido.');

  // Estilos automáticos: negrito, itálico e quebras de página
  const styles = new Map();
  for (const st of byTag(xml, 'style')) {
    const name = st.getAttribute('style:name');
    const tp = byTag(st, 'text-properties')[0];
    const pp = byTag(st, 'paragraph-properties')[0];
    styles.set(name, {
      bold: tp?.getAttribute('fo:font-weight') === 'bold',
      italic: tp?.getAttribute('fo:font-style') === 'italic',
      pageBreak: pp?.getAttribute('fo:break-before') === 'page',
    });
  }

  const out = document.implementation.createHTMLDocument('');
  const body = out.body;

  function convert(node, parent) {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) {
        parent.appendChild(out.createTextNode(c.nodeValue));
        continue;
      }
      if (c.nodeType !== 1) continue;
      const name = c.localName;
      const st = styles.get(c.getAttribute('text:style-name')) || {};
      if (st.pageBreak) {
        const pb = out.createElement('div');
        pb.setAttribute('data-pagebreak', '');
        parent.appendChild(pb);
      }
      let el = null;
      switch (name) {
        case 'h':
          el = out.createElement(`h${Math.min(6, Number(c.getAttribute('text:outline-level')) || 1)}`);
          break;
        case 'p':
          el = out.createElement('p');
          break;
        case 'span':
          el = out.createElement(st.bold ? 'b' : st.italic ? 'i' : 'span');
          if (st.bold && st.italic) {
            const i = out.createElement('i');
            el.appendChild(i);
            parent.appendChild(el);
            convert(c, i);
            continue;
          }
          break;
        case 'list':
          el = out.createElement('ul');
          break;
        case 'list-item':
          el = out.createElement('li');
          break;
        case 'line-break':
          parent.appendChild(out.createElement('br'));
          continue;
        case 's': {
          const n = Number(c.getAttributeNS(NS_TEXT, 'c') || c.getAttribute('text:c')) || 1;
          parent.appendChild(out.createTextNode(' '.repeat(n)));
          continue;
        }
        case 'tab':
          parent.appendChild(out.createTextNode(' '));
          continue;
        case 'image': {
          const img = out.createElement('img');
          img.setAttribute('src', c.getAttribute('xlink:href') || '');
          parent.appendChild(img);
          continue;
        }
        case 'table-cell':
          el = out.createElement('td');
          break;
        case 'note':
        case 'tracked-changes':
        case 'sequence-decls':
          continue; // notas de rodapé e metadados ficam de fora
        default:
          el = null;
      }
      if (el) {
        if (st.bold && name !== 'span') el.style.fontWeight = 'bold';
        if (st.italic && name !== 'span') el.style.fontStyle = 'italic';
        parent.appendChild(el);
        convert(c, el);
      } else {
        convert(c, parent);
      }
    }
  }
  const officeText = byTag(xml, 'text').find((n) => n.namespaceURI !== NS_TEXT) || xml.documentElement;
  convert(officeText, body);
  onProgress?.(0.5);

  const { blocks } = domToBlocks(body);
  return makeReflowBook({
    title: body.querySelector('h1')?.textContent?.trim() || fileName.replace(/\.odt$/i, ''),
    format: 'ODT',
    blocks,
    resolve: async (src) => {
      if (src.startsWith('data:')) return dataUrlToBlob(src);
      const f = zipFile(zip, resolvePath('', src));
      return f ? new Blob([await f.async('uint8array')], { type: mimeFromName(src) }) : null;
    },
    onProgress: (p) => onProgress?.(0.5 + p * 0.5),
  });
}
