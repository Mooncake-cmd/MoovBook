// Livros de layout fixo feitos de imagens: arquivos de imagem soltos,
// quadrinhos CBZ e ZIPs com imagens.

import { IMAGE_EXT, mimeFromName, naturalCompare, blobToBitmap } from './common.js';

/**
 * @param {{name:string, getBlob:()=>Promise<Blob>}[]} entries
 */
export function makeImageBook(entries, title, format = 'Imagens') {
  const sorted = [...entries].sort((a, b) => naturalCompare(a.name, b.name));
  const cache = new Map();

  async function load(i) {
    if (cache.has(i)) return cache.get(i);
    const p = (async () => {
      const blob = await sorted[i].getBlob();
      return blobToBitmap(blob);
    })();
    cache.set(i, p);
    // mantém só algumas imagens decodificadas na memória
    if (cache.size > 6) {
      const [oldKey, oldVal] = cache.entries().next().value;
      cache.delete(oldKey);
      oldVal.then((b) => b.close?.()).catch(() => {});
    }
    return p;
  }

  return {
    kind: 'fixed',
    format,
    title,
    count: sorted.length,
    names: sorted.map((e) => e.name),
    async getPage(i) {
      const bmp = await load(i);
      return {
        width: bmp.width,
        height: bmp.height,
        words: 0,
        async draw(ctx, x, y, w, h) {
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(bmp, x, y, w, h);
        },
      };
    },
    destroy() {
      for (const p of cache.values()) p.then((b) => b.close?.()).catch(() => {});
      cache.clear();
    },
  };
}

export function imageEntriesFromZip(zip) {
  const entries = [];
  zip.forEach((path, file) => {
    if (file.dir) return;
    if (/(^|\/)(__MACOSX|\.)/.test(path)) return; // lixo do macOS / arquivos ocultos
    if (!IMAGE_EXT.test(path)) return;
    entries.push({
      name: path,
      getBlob: async () => new Blob([await file.async('uint8array')], { type: mimeFromName(path) }),
    });
  });
  return entries;
}

export function imageEntriesFromFiles(files) {
  return files.map((f) => ({ name: f.name, getBlob: async () => f }));
}
