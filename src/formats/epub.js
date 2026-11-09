// EPUB 2 e 3 (sem DRM). Lê o OPF, segue a ordem do "spine" e converte cada
// capítulo XHTML em blocos de texto e imagens.

import { resolvePath, zipFile, parseXml, parseHtml, byTag, decodeText, mimeFromName, makeReflowBook } from './common.js';
import { BlockBuilder, domToBlocks } from '../layout/blocks.js';

export async function loadEpub(zip, fileName, onProgress) {
  const containerFile = zipFile(zip, 'META-INF/container.xml');
  if (!containerFile) throw new Error('EPUB inválido: META-INF/container.xml não encontrado.');
  const container = parseXml(await containerFile.async('string'));
  const rootfile = container && byTag(container, 'rootfile')[0];
  const opfPath = rootfile?.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB inválido: arquivo OPF não encontrado.');
  if (zipFile(zip, 'META-INF/encryption.xml') && zipFile(zip, 'META-INF/rights.xml')) {
    throw new Error('Este EPUB parece protegido por DRM e não pode ser lido.');
  }

  const opf = parseXml(await zipFile(zip, opfPath).async('string'));
  if (!opf) throw new Error('EPUB inválido: OPF corrompido.');

  const title = byTag(opf, 'title')[0]?.textContent?.trim() || fileName.replace(/\.epub$/i, '');

  const manifest = new Map();
  let coverHref = null;
  for (const item of byTag(opf, 'item')) {
    const entry = {
      href: resolvePath(opfPath, item.getAttribute('href')),
      type: item.getAttribute('media-type') || '',
      props: item.getAttribute('properties') || '',
    };
    manifest.set(item.getAttribute('id'), entry);
    if (/cover-image/.test(entry.props)) coverHref = entry.href;
  }
  if (!coverHref) {
    const metaCover = byTag(opf, 'meta').find((m) => m.getAttribute('name') === 'cover');
    const it = metaCover && manifest.get(metaCover.getAttribute('content'));
    if (it && /^image\//.test(it.type)) coverHref = it.href;
  }

  const spine = byTag(opf, 'itemref')
    .filter((ref) => ref.getAttribute('linear') !== 'no')
    .map((ref) => manifest.get(ref.getAttribute('idref')))
    .filter((it) => it && /html|xml/.test(it.type));

  const b = new BlockBuilder();
  let index = 0;
  for (const item of spine) {
    const f = zipFile(zip, item.href);
    if (!f) continue;
    const doc = parseHtml(decodeText(await f.async('uint8array')));
    const before = b.blocks.length;
    domToBlocks(doc.body || doc.documentElement, b);
    // corrige caminhos de imagem relativos ao capítulo
    for (let k = before; k < b.blocks.length; k++) {
      const blk = b.blocks[k];
      if (blk.type === 'img') blk.src = resolvePath(item.href, blk.src);
    }
    b.push({ type: 'break' }); // cada capítulo começa numa página nova
    index++;
    onProgress?.(0.6 * (index / spine.length));
  }

  // Inclui a capa se o primeiro capítulo não a mostrar
  if (coverHref) {
    const firstBreak = b.blocks.findIndex((x) => x.type === 'break');
    const head = b.blocks.slice(0, firstBreak < 0 ? b.blocks.length : firstBreak);
    if (!b.blocks.some((x) => x.type === 'img' && x.src === coverHref) && !head.some((x) => x.type === 'img')) {
      b.blocks.unshift({ type: 'img', src: coverHref }, { type: 'break' });
    }
  }

  return makeReflowBook({
    title,
    format: 'EPUB',
    blocks: b.blocks,
    resolve: async (src) => {
      const f = zipFile(zip, src);
      if (!f) return null;
      return new Blob([await f.async('uint8array')], { type: mimeFromName(src) });
    },
    onProgress: (p) => onProgress?.(0.6 + 0.4 * p),
  });
}
