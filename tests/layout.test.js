import { describe, it, expect } from 'vitest';
import { paginate, breakLines } from '../src/layout/paginate.js';
import { domToBlocks, countWords } from '../src/layout/blocks.js';
import { textToBlocks, markdownToHtml, rtfToBlocks } from '../src/formats/text.js';
import { palmDocDecompress, trailingSize } from '../src/formats/mobi.js';
import { resolvePath, decodeText } from '../src/formats/common.js';
import { fitRect } from '../src/render.js';

// medição falsa: cada caractere tem 10px (negrito 11px)
const measure = (text, font) => text.length * (font.includes('bold') ? 11 : 10);
const opts = (extra = {}) => ({
  width: 200, height: 100, fontSize: 10, lineHeight: 2, fontFamily: 'serif', measure, getImage: () => null, ...extra,
});

describe('breakLines', () => {
  it('quebra palavras sem ultrapassar a largura', () => {
    const lines = breakLines([{ text: 'aaa bbb ccc ddd eee' }], 75, () => '10px serif', measure);
    expect(lines.map((l) => l.tokens.map((t) => t.text).join(''))).toEqual(['aaa bbb', 'ccc ddd', 'eee']);
    for (const l of lines) expect(l.width).toBeLessThanOrEqual(75);
  });

  it('quebra palavras gigantes por caractere', () => {
    const lines = breakLines([{ text: 'abcdefghij' }], 40, () => '10px serif', measure);
    expect(lines.map((l) => l.tokens.map((t) => t.text).join(''))).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('respeita quebras forçadas', () => {
    const lines = breakLines([{ text: 'um\ndois' }], 500, () => '10px serif', measure);
    expect(lines).toHaveLength(2);
    expect(lines[0].hardEnd).toBe(true);
  });
});

describe('paginate', () => {
  it('distribui o texto em várias páginas', () => {
    // 5 linhas de 20px cabem em 100px de altura
    const blocks = Array.from({ length: 12 }, (_, i) => ({ type: 'p', runs: [{ text: `linha${i}` }] }));
    const pages = paginate(blocks, opts());
    expect(pages.length).toBeGreaterThan(1);
    const texts = pages.flatMap((p) => p.ops.filter((o) => o.t === 'text').map((o) => o.text));
    expect(texts).toEqual(blocks.map((b) => b.runs[0].text));
    for (const p of pages) for (const op of p.ops) expect(op.y).toBeLessThanOrEqual(100);
  });

  it('força nova página em quebras e conta palavras', () => {
    const pages = paginate([
      { type: 'p', runs: [{ text: 'olá mundo' }] },
      { type: 'break' },
      { type: 'p', runs: [{ text: 'três palavras aqui' }] },
    ], opts());
    expect(pages).toHaveLength(2);
    expect(pages[0].words).toBe(2);
    expect(pages[1].words).toBe(3);
  });

  it('centraliza imagem sozinha na página e respeita a área', () => {
    const pages = paginate([{ type: 'img', src: 'a' }], opts({ getImage: () => ({ width: 400, height: 100 }) }));
    const img = pages[0].ops[0];
    expect(img.w).toBeCloseTo(200);
    expect(img.h).toBeCloseTo(50);
    expect(img.y).toBeCloseTo(25);
  });

  it('justifica linhas preenchendo a largura', () => {
    const pages = paginate([{ type: 'p', runs: [{ text: 'aa bb cc dd ee ff gg hh' }] }], opts({ justify: true, width: 100 }));
    const firstLine = pages[0].ops.filter((o) => o.t === 'text' && o.y === pages[0].ops[0].y);
    const last = firstLine[firstLine.length - 1];
    expect(last.x + measure(last.text, '')).toBeCloseTo(100, 0);
  });
});

describe('domToBlocks', () => {
  it('extrai títulos, parágrafos, estilos, listas e imagens', () => {
    const doc = new DOMParser().parseFromString(`<body>
      <h1>Capítulo 1</h1>
      <p>Era uma <b>vez</b> um <i>livro</i>.</p>
      <ul><li>um</li><li>dois</li></ul>
      <p><img src="img/a.png"></p>
      <div style="page-break-before: always">Depois</div>
      <script>nada()</script>
    </body>`, 'text/html');
    const { blocks } = domToBlocks(doc.body);
    expect(blocks[0]).toMatchObject({ type: 'h', level: 1, runs: [{ text: 'Capítulo 1' }] });
    expect(blocks[1].runs.map((r) => [r.text, r.bold, r.italic])).toEqual([
      ['Era uma ', false, false], ['vez', true, false], [' um ', false, false], ['livro', false, true], ['.', false, false],
    ]);
    expect(blocks[2].runs[0].text).toBe('• um');
    expect(blocks.find((b) => b.type === 'img').src).toBe('img/a.png');
    expect(blocks.some((b) => b.type === 'break')).toBe(true);
    expect(JSON.stringify(blocks)).not.toContain('nada');
  });

  it('converte <br> em quebra de linha', () => {
    const doc = new DOMParser().parseFromString('<p>linha 1<br>linha 2</p>', 'text/html');
    const { blocks } = domToBlocks(doc.body);
    expect(blocks[0].runs[0].text).toBe('linha 1\nlinha 2');
  });
});

describe('formatos de texto', () => {
  it('TXT: une linhas quebradas e detecta capítulos', () => {
    const blocks = textToBlocks('CAPÍTULO I\n\nPrimeira linha\ncontinua aqui.\n\nOutro parágrafo.');
    expect(blocks[0].type).toBe('h');
    expect(blocks[1].runs[0].text).toBe('Primeira linha continua aqui.');
    expect(blocks).toHaveLength(3);
  });

  it('Markdown: gera HTML básico', () => {
    const html = markdownToHtml('# Título\n\nTexto **forte** e *leve*.\n\n- a\n- b\n\n---');
    expect(html).toContain('<h1>Título</h1>');
    expect(html).toContain('<strong>forte</strong>');
    expect(html).toContain('<em>leve</em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<hr>');
  });

  it('RTF: extrai texto, acentos e negrito', () => {
    const blocks = rtfToBlocks("{\\rtf1\\ansi{\\fonttbl{\\f0 Arial;}}\\f0 Ol\\'e1 {\\b mundo}\\par Segunda \\u231?a\\par}");
    expect(blocks[0].runs.map((r) => r.text).join('')).toBe('Olá mundo');
    expect(blocks[0].runs.find((r) => r.text === 'mundo').bold).toBe(true);
    expect(blocks[1].runs[0].text).toBe('Segunda ça');
  });
});

describe('MOBI', () => {
  it('descomprime PalmDOC (literal, espaço+char e referência LZ77)', () => {
    // "abc" + espaço+"d" (0xE4) + cópia de 3 bytes a distância 5 ("abc")
    const dist = 5;
    const len = 3;
    const v = 0x8000 | (dist << 3) | (len - 3);
    const data = new Uint8Array([0x61, 0x62, 0x63, 0xe4, v >> 8, v & 0xff]);
    expect(new TextDecoder().decode(palmDocDecompress(data))).toBe('abc dabc');
  });

  it('calcula o tamanho dos dados extras dos registros', () => {
    // flag multibyte: último byte & 3 + 1
    expect(trailingSize(new Uint8Array([1, 2, 3, 0x01]), 1)).toBe(2);
    expect(trailingSize(new Uint8Array([1, 2, 3]), 0)).toBe(0);
  });
});

describe('utilitários', () => {
  it('resolve caminhos relativos', () => {
    expect(resolvePath('OEBPS/text/ch1.xhtml', '../images/a%20b.jpg#x')).toBe('OEBPS/images/a b.jpg');
    expect(resolvePath('content.opf', 'ch1.xhtml')).toBe('ch1.xhtml');
  });
  it('decodifica UTF-8 e Windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('ação'))).toBe('ação');
    expect(decodeText(new Uint8Array([0x61, 0xe7, 0xe3, 0x6f]))).toBe('açăo'.replace('ă', 'ã'));
  });
  it('conta palavras', () => {
    expect(countWords('Olá, mundo! Guarda-chuva d’água 42')).toBe(5);
  });
  it('ajusta retângulos (conter / preencher)', () => {
    expect(fitRect(100, 200, 400, 200, 'contain')).toEqual({ x: 150, y: 0, w: 100, h: 200 });
    expect(fitRect(100, 200, 400, 200, 'cover')).toMatchObject({ w: 400, h: 800 });
  });
});
