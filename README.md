# MoovBook 📚▶️

Site que converte livros em **vídeo MP4**: cada página do livro vira uma tela do vídeo, e você define quanto tempo cada página fica na tela.

A conversão inteira acontece **no navegador** (WebCodecs + canvas). Nenhum arquivo é enviado para servidor nenhum, então o site pode ser hospedado como página estática (ex.: GitHub Pages).

## Formatos suportados

| Formato | Como é tratado |
|---|---|
| **PDF** | Cada página é renderizada (pdf.js) na resolução do vídeo |
| **EPUB** (2 e 3) | Texto e imagens diagramados em páginas do tamanho do vídeo; cada capítulo começa numa página nova; capa incluída |
| **MOBI / AZW / AZW3** | Kindle **sem DRM** (compressão PalmDOC ou nenhuma) |
| **FB2** / `.fb2.zip` | FictionBook, com capa e imagens |
| **CBZ / ZIP** | Quadrinhos e mangás: cada imagem é uma página (ordenação natural: `2.jpg` antes de `10.jpg`) |
| **DOCX / ODT / RTF** | Documentos de texto |
| **TXT / Markdown / HTML** | Texto puro (detecta parágrafos e capítulos), Markdown e páginas web |
| **Imagens** (JPG, PNG, WEBP, GIF, AVIF, SVG…) | Selecione várias para formar um livro |

Não suportados no momento: CBR (RAR), DjVu, `.doc` antigo, KFX e livros com DRM. Converta-os antes (ex.: com o [Calibre](https://calibre-ebook.com/)) para EPUB ou PDF.

## Recursos

- **Tempo por página**
  - fixo (ex.: 5 s por página), ou
  - por **velocidade de leitura** (palavras por minuto, com mínimo e máximo);
  - **tempo individual** para qualquer página e opção de **tirar páginas** do vídeo;
  - intervalo de páginas (da página X até a Y).
- **Vídeo:** 16:9 (720p, 1080p, 4K), vertical 9:16 (Reels/TikTok/Shorts), 4:5, quadrado, A4 ou tamanho personalizado; 1 a 30 quadros/s; três níveis de qualidade; transição com fade.
- **Layout:** 1 página por tela ou 2 (livro aberto), página inteira ou preenchendo a tela, cor de fundo, número da página.
- **Texto (EPUB, MOBI, DOCX, TXT…):** temas claro/sépia/escuro/lousa, fonte, tamanho, entrelinha, margem e justificação.
- Prévia ao vivo e miniaturas de todas as páginas, estimativa da duração total, barra de progresso com tempo restante e botão de cancelar.

## Requisitos do navegador

A codificação usa a API **WebCodecs**: Chrome/Edge 94+, Safari 17+ e Firefox 130+.
O MoovBook usa **H.264** quando o navegador tem esse codificador (o caso do Chrome, do Edge e do Safari) e, se não tiver, passa para VP9 ou AV1, sempre em arquivo `.mp4`.

## Desenvolvimento

```bash
npm install
npm run dev      # servidor de desenvolvimento
npm test         # testes unitários (vitest)
npm run build    # gera o site estático em dist/
```

### Estrutura

```
src/
  main.js            interface (configurações, miniaturas, prévia, geração)
  render.js          transforma o livro em "telas" e as desenha no canvas
  encoder.js         gera o MP4 (Mediabunny + WebCodecs)
  layout/blocks.js   HTML/XHTML -> blocos (títulos, parágrafos, imagens…)
  layout/paginate.js motor de paginação (quebra de linhas, justificação, imagens)
  formats/           leitores de cada formato (pdf, epub, mobi, fb2, office, text, images)
tests/               testes unitários
```

### Publicação

O workflow `.github/workflows/deploy.yml` publica o site no **GitHub Pages** a cada push na branch `main`. Para ativar, vá em *Settings → Pages → Source: GitHub Actions*.
