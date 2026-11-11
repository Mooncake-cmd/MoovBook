// Utilitários compartilhados pelos leitores de formato.

export const IMAGE_EXT = /\.(jpe?g|png|gif|webp|bmp|avif|svg|tiff?|jfif)$/i;

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
};

export function mimeFromName(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

// Extensões de arquivos de trabalho que programas gravam como "título" do livro
// (ex.: o InDesign grava "Boyer00.indd" no título interno do PDF exportado).
const FILENAME_TITLE = /\.(indd|indt|idml|inx|qxd|qxp|pmd|p65|fm|book|docx?|dotx?|odt|ott|rtf|wpd|pages|pub|pdf|ps|eps|ai|psd|cdr|tex|dvi|txt|md|html?|xhtml|xml|epub|mobi|azw3?)$/i;
const PLACEHOLDER_TITLE = /^(untitled|untitled document|sem t[ií]tulo|documento?\s*\d*|title|t[ií]tulo|unknown|desconhecido|none|null|microsoft word|pdf)$/i;

/**
 * Diz se um título vindo dos metadados do arquivo parece um título de verdade
 * (e não o nome de um arquivo de trabalho, um texto automático ou lixo).
 */
export function isUsableTitle(title) {
  const t = String(title ?? '').trim();
  if (!t) return false;
  if (!/\p{L}/u.test(t)) return false; // só números/símbolos
  if (FILENAME_TITLE.test(t)) return false;
  if (PLACEHOLDER_TITLE.test(t)) return false;
  if (/^microsoft (word|powerpoint|excel|publisher)\s*-/i.test(t)) return false;
  if (/^[a-z]:\\|^\/|^file:/i.test(t)) return false; // caminho de arquivo
  return true;
}

/** Nome do arquivo sem a extensão (trata também ".fb2.zip"). */
export function fileBaseName(name) {
  return name.replace(/\.(fb2\.zip|[^.]+)$/i, '') || name;
}

/** Ordenação "natural": pagina2 < pagina10 */
export const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

/** Decodifica texto tentando BOM, UTF-8 estrito e por fim Windows-1252. */
export function decodeText(bytes, hint) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  if (hint) {
    try {
      return new TextDecoder(hint).decode(u8);
    } catch {
      /* rótulo desconhecido: segue a heurística */
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch {
    return new TextDecoder('windows-1252').decode(u8);
  }
}

/** Resolve um caminho relativo dentro de um arquivo compactado. */
export function resolvePath(basePath, rel) {
  if (!rel) return '';
  let r = rel.split('#')[0].split('?')[0];
  try {
    r = decodeURIComponent(r);
  } catch {
    /* mantém como está */
  }
  if (/^[a-z]+:/i.test(r)) return r;
  const parts = r.startsWith('/') ? [] : basePath.split('/').slice(0, -1);
  for (const seg of r.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Busca um arquivo no zip ignorando maiúsculas/minúsculas se necessário. */
export function zipFile(zip, path) {
  const f = zip.file(path);
  if (f) return f;
  const lower = path.toLowerCase();
  let found = null;
  zip.forEach((p, file) => {
    if (!found && p.toLowerCase() === lower) found = file;
  });
  return found;
}

export function parseXml(text, type = 'application/xml') {
  const doc = new DOMParser().parseFromString(text, type);
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc;
}

/** Faz o parse de (X)HTML de forma tolerante. */
export function parseHtml(text) {
  if (/<\?xml|xmlns=/.test(text.slice(0, 1000))) {
    const x = parseXml(text, 'application/xhtml+xml');
    if (x) return x;
  }
  return new DOMParser().parseFromString(text, 'text/html');
}

export function byTag(root, name) {
  // getElementsByTagNameNS('*') ignora prefixos de namespace
  return Array.from(root.getElementsByTagNameNS ? root.getElementsByTagNameNS('*', name) : root.getElementsByTagName(name));
}

export function base64ToBlob(b64, type) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type });
}

export async function dataUrlToBlob(url) {
  const res = await fetch(url);
  return res.blob();
}

/**
 * Finaliza um livro "fluido" (texto que precisa ser paginado): carrega as
 * imagens referenciadas pelos blocos e descarta as que não puderem ser lidas.
 * @param {{title:string, blocks:Array, resolve:(src:string)=>Promise<Blob|null>, format:string}} p
 */
export async function makeReflowBook({ title, blocks, resolve, format, onProgress }) {
  const images = new Map();
  const imgBlocks = blocks.filter((b) => b.type === 'img');
  let done = 0;
  for (const b of imgBlocks) {
    if (!images.has(b.src)) {
      images.set(b.src, null);
      try {
        const blob = await resolve(b.src);
        if (blob) {
          const bitmap = await blobToBitmap(blob);
          // ignora imagens minúsculas (marcadores, espaçadores)
          if (bitmap && bitmap.width >= 24 && bitmap.height >= 24) images.set(b.src, { bitmap, width: bitmap.width, height: bitmap.height });
          else bitmap?.close?.();
        }
      } catch (e) {
        console.warn('Imagem ignorada:', b.src, e);
      }
    }
    done++;
    onProgress?.(done / imgBlocks.length);
  }
  const cleaned = blocks.filter((b) => b.type !== 'img' || images.get(b.src));
  // remove quebras duplicadas / iniciais
  const final = [];
  for (const b of cleaned) {
    if (b.type === 'break' && (!final.length || final[final.length - 1].type === 'break')) continue;
    final.push(b);
  }
  while (final.length && final[final.length - 1].type === 'break') final.pop();
  if (!final.some((b) => b.type !== 'break')) throw new Error('Não foi encontrado nenhum conteúdo legível neste arquivo.');
  return {
    kind: 'reflow',
    format,
    title,
    blocks: final,
    images,
    destroy() {
      for (const v of images.values()) v?.bitmap?.close?.();
    },
  };
}

export async function blobToBitmap(blob) {
  if (blob.type === 'image/svg+xml' || !('createImageBitmap' in globalThis)) {
    // SVG precisa passar por um <img> para ser rasterizado
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      const w = img.naturalWidth || 800;
      const h = img.naturalHeight || 600;
      return await createImageBitmap(img, { resizeWidth: w, resizeHeight: h });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  return createImageBitmap(blob);
}
