// Kindle MOBI / AZW / AZW3 (sem DRM, compressão PalmDOC ou nenhuma).
// Lê o banco PalmDB, descomprime os registros de texto e trata o resultado
// como HTML. As imagens são referenciadas por "recindex" (MOBI 6) ou
// "kindle:embed:XXXX" (KF8/AZW3).

import { parseHtml, makeReflowBook } from './common.js';
import { domToBlocks } from '../layout/blocks.js';

export async function loadMobi(bytes, fileName, onProgress) {
  const buf = new Uint8Array(bytes);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = new TextDecoder('ascii').decode(buf.subarray(60, 68));
  if (type !== 'BOOKMOBI' && type !== 'TEXtREAd') throw new Error('Arquivo MOBI/AZW inválido.');

  const numRecords = dv.getUint16(76);
  const offsets = [];
  for (let i = 0; i < numRecords; i++) offsets.push(dv.getUint32(78 + i * 8));
  offsets.push(buf.length);
  const record = (i) => buf.subarray(offsets[i], offsets[i + 1]);

  const r0 = record(0);
  const r0v = new DataView(r0.buffer, r0.byteOffset, r0.byteLength);
  const compression = r0v.getUint16(0);
  const textRecords = r0v.getUint16(8);
  const encryption = r0v.getUint16(12);
  if (encryption !== 0) throw new Error('Este livro Kindle está protegido por DRM e não pode ser convertido.');
  if (compression !== 1 && compression !== 2) {
    throw new Error('Este MOBI usa compressão HUFF/CDIC, ainda não suportada. Converta-o para EPUB (ex.: com o Calibre) e tente novamente.');
  }

  let encoding = 'windows-1252';
  let extraFlags = 0;
  let firstImage = -1;
  let title = fileName.replace(/\.(mobi|azw3?|prc)$/i, '');
  const hasMobiHeader = new TextDecoder('ascii').decode(r0.subarray(16, 20)) === 'MOBI';
  if (hasMobiHeader) {
    const headerLen = r0v.getUint32(20);
    if (r0v.getUint32(28) === 65001) encoding = 'utf-8';
    firstImage = r0v.getUint32(108);
    if (headerLen >= 0xe4) extraFlags = r0v.getUint16(0xf2);
    const nameOff = r0v.getUint32(84);
    const nameLen = r0v.getUint32(88);
    if (nameLen > 0 && nameOff + nameLen <= r0.length) {
      title = new TextDecoder(encoding).decode(r0.subarray(nameOff, nameOff + nameLen)).trim() || title;
    }
  }

  const chunks = [];
  let total = 0;
  for (let i = 1; i <= textRecords && i < numRecords; i++) {
    let data = record(i);
    data = data.subarray(0, data.length - trailingSize(data, extraFlags));
    const out = compression === 2 ? palmDocDecompress(data) : data;
    chunks.push(out);
    total += out.length;
    if (i % 50 === 0) onProgress?.(0.3 * (i / textRecords));
  }
  const all = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    all.set(c, pos);
    pos += c.length;
  }
  const html = new TextDecoder(encoding).decode(all);
  const doc = parseHtml(html.includes('<html') ? html : `<html><body>${html}</body></html>`);
  const { blocks } = domToBlocks(doc.body || doc.documentElement);

  return makeReflowBook({
    title,
    format: 'MOBI',
    blocks,
    resolve: async (src) => {
      let idx = -1;
      const m1 = /^recindex:(\d+)/.exec(src);
      const m2 = /kindle:embed:([0-9A-V]+)/i.exec(src);
      if (m1) idx = parseInt(m1[1], 10);
      else if (m2) idx = parseInt(m2[1], 32);
      if (idx < 1 || firstImage < 0) return null;
      const recNo = firstImage + idx - 1;
      if (recNo >= numRecords) return null;
      return new Blob([record(recNo)], { type: sniffImage(record(recNo)) });
    },
    onProgress: (p) => onProgress?.(0.3 + 0.7 * p),
  });
}

function sniffImage(d) {
  if (d[0] === 0xff && d[1] === 0xd8) return 'image/jpeg';
  if (d[0] === 0x89 && d[1] === 0x50) return 'image/png';
  if (d[0] === 0x47 && d[1] === 0x49) return 'image/gif';
  if (d[0] === 0x42 && d[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

/** Tamanho dos dados extras no fim de cada registro de texto. */
export function trailingSize(data, flags) {
  let num = 0;
  let f = flags >> 1;
  while (f) {
    if (f & 1) num += backwardVarint(data, data.length - num);
    f >>= 1;
  }
  if (flags & 1) num += (data[data.length - num - 1] & 0x3) + 1;
  return Math.min(num, data.length);
}

function backwardVarint(data, end) {
  let bitpos = 0;
  let result = 0;
  let p = end;
  while (p > 0) {
    const v = data[p - 1];
    result |= (v & 0x7f) << bitpos;
    bitpos += 7;
    p--;
    if (v & 0x80 || bitpos >= 28) break;
  }
  return result;
}

/** Descompressão LZ77 do PalmDOC. */
export function palmDocDecompress(data) {
  const out = new Uint8Array(data.length * 8);
  let o = 0;
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c >= 1 && c <= 8) {
      for (let k = 0; k < c && i < data.length; k++) out[o++] = data[i++];
    } else if (c < 0x80) {
      out[o++] = c;
    } else if (c >= 0xc0) {
      out[o++] = 0x20;
      out[o++] = c ^ 0x80;
    } else if (i < data.length) {
      const v = (c << 8) | data[i++];
      const dist = (v >> 3) & 0x7ff;
      const len = (v & 7) + 3;
      for (let k = 0; k < len; k++) {
        out[o] = out[o - dist];
        o++;
      }
    }
  }
  return out.subarray(0, o);
}
