// Detecta o formato do(s) arquivo(s) e carrega o livro correspondente.

import JSZip from 'jszip';
import { IMAGE_EXT, zipFile } from './common.js';
import { makeImageBook, imageEntriesFromZip, imageEntriesFromFiles } from './images.js';

export const SUPPORTED = [
  { ext: 'PDF', desc: 'Documentos PDF' },
  { ext: 'EPUB', desc: 'Livros digitais (EPUB 2 e 3, sem DRM)' },
  { ext: 'MOBI · AZW · AZW3', desc: 'Kindle sem DRM' },
  { ext: 'FB2', desc: 'FictionBook (também .fb2.zip)' },
  { ext: 'CBZ · ZIP', desc: 'Quadrinhos/mangás e pastas de imagens compactadas' },
  { ext: 'DOCX · ODT · RTF', desc: 'Documentos de texto' },
  { ext: 'TXT · MD · HTML', desc: 'Texto puro, Markdown e páginas web' },
  { ext: 'JPG · PNG · WEBP · GIF · AVIF · SVG', desc: 'Imagens soltas (cada imagem é uma página)' },
];

export const ACCEPT = [
  '.pdf', '.epub', '.mobi', '.azw', '.azw3', '.prc', '.fb2', '.cbz', '.zip', '.docx', '.odt', '.rtf',
  '.txt', '.text', '.md', '.markdown', '.html', '.htm', '.xhtml',
  '.jpg', '.jpeg', '.jfif', '.png', '.webp', '.gif', '.bmp', '.avif', '.svg',
].join(',');

const UNSUPPORTED = {
  cbr: 'CBR (RAR) ainda não é suportado. Extraia as imagens ou converta para CBZ e tente de novo.',
  rar: 'Arquivos RAR ainda não são suportados. Converta para ZIP/CBZ.',
  djvu: 'DjVu ainda não é suportado. Converta para PDF e tente novamente.',
  doc: 'O formato .doc antigo não é suportado. Salve como .docx ou PDF.',
  kfx: 'KFX não é suportado. Converta para EPUB (ex.: com o Calibre).',
  lit: 'LIT não é suportado. Converta para EPUB (ex.: com o Calibre).',
};

/**
 * @param {File[]} files
 * @param {(p:number)=>void} [onProgress]
 */
export async function loadBook(files, onProgress) {
  if (!files.length) throw new Error('Nenhum arquivo selecionado.');

  // Várias imagens soltas formam um único livro
  if (files.length > 1) {
    const images = files.filter((f) => IMAGE_EXT.test(f.name));
    if (images.length !== files.length) throw new Error('Para enviar vários arquivos de uma vez, todos devem ser imagens. Para outros formatos, envie um livro por vez.');
    return makeImageBook(imageEntriesFromFiles(images), commonPrefix(images.map((f) => f.name)) || 'Imagens', 'Imagens');
  }

  const file = files[0];
  const name = file.name;
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
  const base = name.replace(/\.[^.]+$/, '');
  if (UNSUPPORTED[ext]) throw new Error(UNSUPPORTED[ext]);

  const head = new Uint8Array(await file.slice(0, 80).arrayBuffer());
  const magic = new TextDecoder('latin1').decode(head);

  if (IMAGE_EXT.test(name)) return makeImageBook(imageEntriesFromFiles([file]), base, 'Imagem');

  if (magic.startsWith('%PDF') || ext === 'pdf') {
    const { loadPdf } = await import('./pdf.js');
    return loadPdf(file);
  }

  if (magic.slice(60, 68) === 'BOOKMOBI' || magic.slice(60, 68) === 'TEXtREAd' || ['mobi', 'azw', 'azw3', 'prc'].includes(ext)) {
    const { loadMobi } = await import('./mobi.js');
    return loadMobi(await file.arrayBuffer(), name, onProgress);
  }

  if (magic.startsWith('PK')) {
    const zip = await JSZip.loadAsync(file);
    onProgress?.(0.05);
    const mimetypeFile = zipFile(zip, 'mimetype');
    const mimetype = mimetypeFile ? (await mimetypeFile.async('string')).trim() : '';
    if (mimetype === 'application/epub+zip' || zipFile(zip, 'META-INF/container.xml')) {
      const { loadEpub } = await import('./epub.js');
      return loadEpub(zip, name, onProgress);
    }
    if (zipFile(zip, 'word/document.xml')) {
      const { loadDocx } = await import('./office.js');
      return loadDocx(file, onProgress);
    }
    if (mimetype.startsWith('application/vnd.oasis.opendocument.text')) {
      const { loadOdt } = await import('./office.js');
      return loadOdt(zip, name, onProgress);
    }
    const fb2 = zip.file(/\.fb2$/i)[0];
    if (fb2) {
      const { loadFb2 } = await import('./fb2.js');
      return loadFb2(await fb2.async('arraybuffer'), fb2.name, onProgress);
    }
    const images = imageEntriesFromZip(zip);
    if (images.length) return makeImageBook(images, base, ext === 'cbz' ? 'CBZ' : 'ZIP');
    throw new Error('Este arquivo ZIP não contém um livro ou imagens reconhecíveis.');
  }

  if (magic.startsWith('Rar!')) throw new Error(UNSUPPORTED.cbr);
  if (magic.startsWith('AT&TFORM')) throw new Error(UNSUPPORTED.djvu);

  if (ext === 'fb2' || /<FictionBook/i.test(magic + (await file.slice(80, 400).text()))) {
    const { loadFb2 } = await import('./fb2.js');
    return loadFb2(await file.arrayBuffer(), name, onProgress);
  }

  const text = await import('./text.js');
  if (magic.startsWith('{\\rtf') || ext === 'rtf') return text.loadRtf(file);
  if (['md', 'markdown'].includes(ext)) return text.loadMarkdown(file);
  if (['html', 'htm', 'xhtml'].includes(ext) || /^\s*<(!doctype html|html)/i.test(magic)) return text.loadHtml(file);
  if (['txt', 'text', ''].includes(ext) || isProbablyText(head)) return text.loadTxt(file);

  throw new Error(`Formato não reconhecido: .${ext}`);
}

function isProbablyText(bytes) {
  let bad = 0;
  for (const b of bytes) if (b < 9 || (b > 13 && b < 32)) bad++;
  return bad < bytes.length * 0.02;
}

function commonPrefix(names) {
  if (!names.length) return '';
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  return p.replace(/[\s_\-.(\d]+$/, '');
}
