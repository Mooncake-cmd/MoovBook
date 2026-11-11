import './styles.css';
import { loadBook, SUPPORTED, ACCEPT } from './formats/index.js';
import { buildDocument, ensureFonts, FONT_FAMILIES } from './render.js';
import { encodeVideo, pickCodec, codecLabel, webCodecsAvailable } from './encoder.js';
import {
  startKeepAlive, stopKeepAlive, tabStart, tabProgress, tabFinished, tabReset,
  notify, notificationsSupported, requestNotificationPermission,
} from './background.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const THEMES = {
  light: { page: '#ffffff', text: '#1d1d1f' },
  sepia: { page: '#f4ecd8', text: '#5b4636' },
  dark: { page: '#121212', text: '#e6e6e6' },
  slate: { page: '#1e293b', text: '#f8fafc' },
};
const STORAGE_KEY = 'moovbook.settings.v1';

const state = {
  book: null,
  doc: null,
  gen: 0,
  overrides: new Map(), // quadro -> segundos
  excluded: new Set(), // quadros removidos do vídeo
  words: new Map(), // quadro -> nº de palavras
  current: 0,
  busy: false,
  abort: null,
  resultUrl: null,
};

// ---------------------------------------------------------------- inicialização

$('#formats').innerHTML = SUPPORTED.map((f) => `<li><b>${f.ext}</b><span>${f.desc}</span></li>`).join('');
$('#file-input').accept = ACCEPT;
$('#s-font').innerHTML = Object.entries(FONT_FAMILIES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');

restoreSettings();
if (!notificationsSupported) {
  $('#notify-row').hidden = true;
  $('#s-notify').checked = false;
} else if (Notification.permission !== 'granted') {
  $('#s-notify').checked = false; // a permissão foi retirada (ou nunca dada) desde a última visita
}
$('#s-notify').addEventListener('change', async (e) => {
  if (!e.target.checked) return;
  const ok = await requestNotificationPermission();
  if (!ok) {
    e.target.checked = false;
    saveSettings();
    toast('As notificações estão bloqueadas para este site. Libere nas configurações do navegador (ícone à esquerda do endereço).', 7000);
  }
});
updateVisibility();
updateOutputs();

if (!webCodecsAvailable()) {
  setStatus('⚠️ Seu navegador não suporta a codificação de vídeo (WebCodecs). Você pode carregar e visualizar o livro, mas para gerar o MP4 use uma versão recente do Chrome, Edge, Safari ou Firefox.', 'warn');
}

const dropzone = $('#dropzone');
$('#file-input').addEventListener('change', (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (files.length) openFiles(files);
});
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    $('#file-input').click();
  }
});
['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  if (!state.book) dropzone.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => document.addEventListener(ev, (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
}));
document.addEventListener('drop', (e) => {
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length && !state.busy) openFiles(files);
});

$('#btn-change').addEventListener('click', () => {
  if (state.busy) return;
  closeBook();
});

// ---------------------------------------------------------------- carregamento

async function openFiles(files) {
  closeBook();
  setStatus(`Abrindo ${files.length > 1 ? `${files.length} arquivos` : files[0].name}…`);
  dropzone.classList.add('loading');
  try {
    const book = await loadBook(files, (p) => setStatus(`Lendo o livro… ${Math.round(p * 100)}%`));
    state.book = book;
    $('#book-title').textContent = book.title;
    $('#book-format').textContent = book.format;
    document.title = `${book.title} — MoovBook`;

    // padrões sensatos por tipo de livro
    const [w, h] = currentResolution();
    setRadio('per', book.kind === 'reflow' && w > h * 1.2 ? '2' : '1');

    if (book.kind === 'reflow') await ensureFonts(readSettings().fontFamily);
    setStatus('');
    $('#step-upload').hidden = true;
    $('#step-editor').hidden = false;
    rebuild(true);
    window.scrollTo({ top: 0 });
  } catch (err) {
    console.error(err);
    setStatus(`❌ ${err.message || err}`, 'error');
  } finally {
    dropzone.classList.remove('loading');
  }
}

function closeBook() {
  tabReset();
  state.book?.destroy?.();
  state.book = null;
  state.doc = null;
  state.overrides.clear();
  state.excluded.clear();
  state.words.clear();
  state.gen++;
  clearResult();
  $('#thumbs').innerHTML = '';
  $('#step-editor').hidden = true;
  $('#step-upload').hidden = false;
  document.title = 'MoovBook — Livros em vídeo MP4';
}

function setStatus(msg, kind = '') {
  const el = $('#load-status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

// ---------------------------------------------------------------- configurações

function radio(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value;
}
function setRadio(name, value) {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}
function num(id, fallback) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
}

function currentResolution() {
  const v = $('#s-resolution').value;
  if (v === 'custom') {
    const even = (n) => Math.max(128, Math.min(4096, Math.round(n / 2) * 2));
    return [even(num('#s-w', 1920)), even(num('#s-h', 1080))];
  }
  return v.split('x').map(Number);
}

function readSettings() {
  const [width, height] = currentResolution();
  const theme = THEMES[radio('theme')] || THEMES.light;
  return {
    width,
    height,
    timing: radio('timing'),
    seconds: Math.max(0.5, num('#s-seconds', 5)),
    wpm: Math.max(20, num('#s-wpm', 200)),
    minSeconds: Math.max(0.5, num('#s-min', 4)),
    maxSeconds: Math.max(1, num('#s-max', 120)),
    fps: num('#s-fps', 30),
    quality: $('#s-quality').value,
    transition: num('#s-transition', 0),
    pagesPerFrame: Number(radio('per')) === 2 ? 2 : 1,
    fit: radio('fit'),
    background: $('#s-bg').value,
    pageNumbers: $('#s-pagenum').checked,
    pageColor: theme.page,
    textColor: theme.text,
    fontFamily: $('#s-font').value,
    fontSize: num('#s-fontsize', 38),
    lineHeight: num('#s-lineheight', 1.5),
    margin: num('#s-margin', 7),
    justify: $('#s-justify').checked,
  };
}

const PERSISTED = ['#s-seconds', '#s-wpm', '#s-min', '#s-max', '#s-fps', '#s-quality', '#s-transition', '#s-notify', '#s-resolution', '#s-w', '#s-h', '#s-bg', '#s-pagenum', '#s-font', '#s-fontsize', '#s-lineheight', '#s-margin', '#s-justify'];
const PERSISTED_RADIOS = ['timing', 'fit', 'theme'];

function saveSettings() {
  try {
    const data = {};
    for (const id of PERSISTED) {
      const el = $(id);
      data[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    for (const r of PERSISTED_RADIOS) data[`radio:${r}`] = radio(r);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* armazenamento indisponível: tudo bem */
  }
}

function restoreSettings() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!data) return;
    for (const id of PERSISTED) {
      const el = $(id);
      if (!el || !(id in data)) continue;
      if (el.type === 'checkbox') el.checked = !!data[id];
      else el.value = data[id];
    }
    for (const r of PERSISTED_RADIOS) if (data[`radio:${r}`]) setRadio(r, data[`radio:${r}`]);
  } catch {
    /* ignora */
  }
}

function updateVisibility() {
  const values = {
    timing: radio('timing'),
    resolution: $('#s-resolution').value === 'custom' ? 'custom' : 'preset',
    kind: state.book?.kind || 'none',
    per: radio('per'),
  };
  for (const el of $$('[data-show]')) {
    const [k, v] = el.dataset.show.split('=');
    el.hidden = values[k] !== v;
  }
}

function updateOutputs() {
  $('#o-fontsize').textContent = `${$('#s-fontsize').value}px`;
  $('#o-lineheight').textContent = Number($('#s-lineheight').value).toFixed(2);
  $('#o-margin').textContent = `${$('#s-margin').value}%`;
}

const LAYOUT_INPUTS = new Set(['s-resolution', 's-w', 's-h', 's-bg', 's-pagenum', 's-font', 's-fontsize', 's-lineheight', 's-margin', 's-justify', 'per', 'fit', 'theme']);
let rebuildTimer = 0;
let oldPageCount = 0;

$('.settings').addEventListener('input', onSettingChange);
$('.settings').addEventListener('change', onSettingChange);

function onSettingChange(e) {
  const key = e.target.name || e.target.id;
  updateVisibility();
  updateOutputs();
  saveSettings();
  if (!state.book) return;
  if (LAYOUT_INPUTS.has(key)) {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(async () => {
      if (key === 's-font') await ensureFonts(readSettings().fontFamily);
      rebuild(false);
    }, e.type === 'input' && e.target.type === 'range' ? 200 : 60);
  } else {
    refreshDurations();
  }
}

// ---------------------------------------------------------------- documento / miniaturas

function rebuild(fresh) {
  if (!state.book) return;
  const s = readSettings();
  const oldCount = state.doc?.count;
  state.doc = buildDocument(state.book, s);
  state.gen++;
  state.words.clear();
  clearResult();

  const doc = state.doc;
  if (fresh || doc.count !== oldCount) {
    if (!fresh && (state.overrides.size || state.excluded.size)) {
      toast('A quantidade de páginas mudou — os tempos individuais foram restaurados.');
    }
    state.overrides.clear();
    state.excluded.clear();
    state.current = Math.min(state.current, doc.count - 1);
    const fromEl = $('#s-from');
    const toEl = $('#s-to');
    fromEl.max = toEl.max = doc.pageCount;
    if (fresh || num('#s-to', 0) > doc.pageCount || num('#s-to', 0) === oldPageCount) toEl.value = doc.pageCount;
    if (num('#s-from', 1) > doc.pageCount) fromEl.value = 1;
  }
  oldPageCount = doc.pageCount;

  const kindLabel = state.book.kind === 'reflow' ? 'texto diagramado' : 'layout fixo';
  $('#book-meta').textContent = `${doc.pageCount} página${doc.pageCount === 1 ? '' : 's'} · ${kindLabel}`;
  $('#sum-res').textContent = `${s.width}×${s.height}`;
  updateVisibility();
  buildThumbs();
  renderPreview();
  refreshDurations();
}

function slideLabel(i) {
  const pages = state.doc.slidePages(i).map((p) => p + 1);
  return pages.length > 1 ? `Págs. ${pages[0]}–${pages[pages.length - 1]}` : `Pág. ${pages[0]}`;
}

function inRange(i) {
  const from = Math.max(1, num('#s-from', 1));
  const to = Math.max(from, num('#s-to', Infinity));
  return state.doc.slidePages(i).some((p) => p + 1 >= from && p + 1 <= to);
}

function includedSlides() {
  const out = [];
  for (let i = 0; i < state.doc.count; i++) if (inRange(i) && !state.excluded.has(i)) out.push(i);
  return out;
}

let observer = null;
const thumbQueue = [];
let thumbRunning = 0;

function buildThumbs() {
  const doc = state.doc;
  const gen = state.gen;
  const grid = $('#thumbs');
  observer?.disconnect();
  thumbQueue.length = 0;
  grid.style.setProperty('--ar', `${doc.width} / ${doc.height}`);
  grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < doc.count; i++) {
    const card = document.createElement('div');
    card.className = 'thumb';
    card.dataset.i = i;
    card.innerHTML = `
      <button type="button" class="thumb-img" aria-label="Ver ${slideLabel(i)}"><canvas></canvas></button>
      <div class="thumb-meta">
        <label class="inc"><input type="checkbox" checked aria-label="Incluir ${slideLabel(i)}"><span>${slideLabel(i)}</span></label>
        <div class="with-unit tiny"><input type="number" min="0.5" max="3600" step="0.5" aria-label="Segundos para ${slideLabel(i)}"><span>s</span></div>
      </div>`;
    frag.appendChild(card);
  }
  grid.appendChild(frag);
  $('#pages-count').textContent = doc.perFrame === 2 ? `(${doc.pageCount} páginas em ${doc.count} telas)` : `(${doc.count})`;
  $('#sum-frames-label').textContent = doc.perFrame === 2 ? 'telas no vídeo' : 'páginas no vídeo';

  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      observer.unobserve(en.target);
      thumbQueue.push({ card: en.target, gen });
      pumpThumbs();
    }
  }, { rootMargin: '400px' });
  for (const card of grid.children) observer.observe(card);
  markCurrent();
}

async function pumpThumbs() {
  while (thumbRunning < 2 && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (job.gen !== state.gen) continue;
    thumbRunning++;
    renderThumb(job).finally(() => {
      thumbRunning--;
      pumpThumbs();
    });
  }
}

async function renderThumb({ card, gen }) {
  const doc = state.doc;
  const i = Number(card.dataset.i);
  const canvas = card.querySelector('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const tw = Math.round(200 * dpr);
  const scale = tw / doc.width;
  const off = document.createElement('canvas');
  off.width = tw;
  off.height = Math.round(doc.height * scale);
  const ctx = off.getContext('2d');
  ctx.scale(scale, scale);
  try {
    await doc.drawSlide(ctx, i, scale);
    if (gen !== state.gen) return;
    canvas.width = off.width;
    canvas.height = off.height;
    canvas.getContext('2d').drawImage(off, 0, 0);
    card.classList.add('ready');
  } catch (e) {
    console.warn('Falha na miniatura', i, e);
  }
}

$('#thumbs').addEventListener('click', (e) => {
  const btn = e.target.closest('.thumb-img');
  if (!btn) return;
  state.current = Number(btn.closest('.thumb').dataset.i);
  renderPreview();
});

$('#thumbs').addEventListener('input', (e) => {
  const card = e.target.closest('.thumb');
  if (!card) return;
  const i = Number(card.dataset.i);
  if (e.target.type === 'number') {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v > 0) state.overrides.set(i, Math.min(3600, Math.max(0.5, v)));
    else state.overrides.delete(i);
    card.classList.toggle('custom', state.overrides.has(i));
  } else if (e.target.type === 'checkbox') {
    if (e.target.checked) state.excluded.delete(i);
    else state.excluded.add(i);
    card.classList.toggle('off', !e.target.checked);
  }
  refreshDurations();
});

$('#btn-reset-overrides').addEventListener('click', () => {
  state.overrides.clear();
  for (const inp of $$('#thumbs input[type=number]')) inp.value = '';
  for (const c of $$('#thumbs .thumb')) c.classList.remove('custom');
  refreshDurations();
});
$('#btn-include-all').addEventListener('click', () => {
  state.excluded.clear();
  $('#s-from').value = 1;
  $('#s-to').value = state.doc?.pageCount || 1;
  for (const inp of $$('#thumbs input[type=checkbox]')) inp.checked = true;
  for (const c of $$('#thumbs .thumb')) c.classList.remove('off');
  refreshDurations();
});

// ---------------------------------------------------------------- prévia

let previewToken = 0;
async function renderPreview() {
  const doc = state.doc;
  if (!doc) return;
  const token = ++previewToken;
  const i = state.current;
  const canvas = $('#preview');
  const stage = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const maxCssW = Math.min(stage.clientWidth || 800, ((stage.clientHeight || 600) * doc.width) / doc.height);
  const pxW = Math.min(doc.width, Math.round(maxCssW * dpr));
  const scale = pxW / doc.width;
  const off = document.createElement('canvas');
  off.width = pxW;
  off.height = Math.round(doc.height * scale);
  const ctx = off.getContext('2d');
  ctx.scale(scale, scale);
  $('#preview-label').textContent = `Prévia · ${slideLabel(i)}`;
  stage.style.aspectRatio = `${doc.width} / ${doc.height}`;
  markCurrent();
  try {
    await doc.drawSlide(ctx, i, scale);
  } catch (e) {
    console.warn(e);
    return;
  }
  if (token !== previewToken) return;
  canvas.width = off.width;
  canvas.height = off.height;
  canvas.getContext('2d').drawImage(off, 0, 0);
  updatePreviewDuration();
}

function markCurrent() {
  for (const c of $$('#thumbs .thumb.current')) c.classList.remove('current');
  $(`#thumbs .thumb[data-i="${state.current}"]`)?.classList.add('current');
}

$('#btn-prev').addEventListener('click', () => step(-1));
$('#btn-next').addEventListener('click', () => step(1));
document.addEventListener('keydown', (e) => {
  if (!state.doc || state.busy || /input|select|textarea/i.test(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});
function step(d) {
  if (!state.doc) return;
  state.current = Math.max(0, Math.min(state.doc.count - 1, state.current + d));
  renderPreview();
  $(`#thumbs .thumb[data-i="${state.current}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderPreview, 150);
});

// ---------------------------------------------------------------- durações

async function wordsOf(i) {
  if (!state.words.has(i)) state.words.set(i, await state.doc.words(i));
  return state.words.get(i);
}

/** Duração automática (sem ajuste manual) de um quadro. */
async function autoDuration(i, s = readSettings()) {
  if (s.timing !== 'reading') return s.seconds;
  const w = await wordsOf(i);
  const secs = (w / s.wpm) * 60;
  return Math.round(Math.min(s.maxSeconds, Math.max(s.minSeconds, secs)) * 10) / 10;
}

async function durationOf(i, s) {
  return state.overrides.get(i) ?? autoDuration(i, s);
}

let durToken = 0;
async function refreshDurations() {
  const doc = state.doc;
  if (!doc) return;
  const token = ++durToken;
  const s = readSettings();
  const slides = includedSlides();
  const included = new Set(slides);
  const cards = $('#thumbs').children;

  for (let i = 0; i < doc.count; i++) {
    const card = cards[i];
    if (card) card.classList.toggle('out', !inRange(i));
  }

  $('#sum-frames').textContent = String(slides.length);
  const needsWords = s.timing === 'reading' && doc.hasWords;
  if (needsWords) $('#sum-duration').textContent = 'calculando…';

  let total = 0;
  for (let k = 0; k < doc.count; k++) {
    const auto = await autoDuration(k, s);
    if (token !== durToken) return;
    const inp = cards[k]?.querySelector('input[type=number]');
    if (inp) inp.placeholder = formatSecs(auto);
    if (included.has(k)) total += state.overrides.get(k) ?? auto;
    if (needsWords && k % 25 === 0) $('#sum-duration').textContent = `calculando… ${Math.round((k / doc.count) * 100)}%`;
  }
  if (token !== durToken) return;
  // aproxima ao que o codificador fará (arredondamento por quadro)
  $('#sum-duration').textContent = formatTime(total);
  $('#btn-generate').disabled = !slides.length || state.busy;
  updatePreviewDuration();
}

async function updatePreviewDuration() {
  if (!state.doc) return;
  const i = state.current;
  const d = await durationOf(i, readSettings());
  const excluded = !inRange(i) || state.excluded.has(i);
  $('#preview-duration').textContent = excluded ? ' · fora do vídeo' : ` · ${formatSecs(d)} s na tela`;
}

function formatSecs(s) {
  return (Math.round(s * 10) / 10).toLocaleString('pt-BR');
}
function formatTime(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}min`;
  if (m) return `${m}min ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

// ---------------------------------------------------------------- geração do vídeo

$('#btn-generate').addEventListener('click', generate);
$('#btn-cancel').addEventListener('click', () => state.abort?.abort());

async function generate() {
  if (state.busy || !state.doc) return;
  const s = readSettings();
  const slides = includedSlides();
  if (!slides.length) return;

  // precisa começar ainda "dentro" do clique, antes de qualquer await
  startKeepAlive();

  const codec = await pickCodec(s.width, s.height, s.quality);
  if (!codec) {
    stopKeepAlive();
    toast('Seu navegador não consegue codificar vídeo nesta resolução. Tente uma resolução menor ou outro navegador (Chrome/Edge recentes).', 6000);
    return;
  }

  clearResult();
  state.busy = true;
  state.abort = new AbortController();
  document.body.classList.add('busy');
  $('#btn-generate').disabled = true;
  $('#progress-panel').hidden = false;
  $('#progress-bar').style.width = '0%';
  $('#progress-title').textContent = 'Gerando vídeo…';
  $('#progress-text').textContent = 'Preparando…';
  $('#progress-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const bookTitle = state.book.title;
  tabStart(document.title, bookTitle);

  let wakeLock = null;
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    /* opcional */
  }

  const started = performance.now();
  try {
    const result = await encodeVideo({
      doc: state.doc,
      slides,
      durationOf: (i) => durationOf(i, s),
      fps: s.fps,
      transition: s.fps >= 5 ? s.transition : 0,
      quality: s.quality,
      signal: state.abort.signal,
      onProgress: ({ page, total, time, totalTime }) => {
        const frac = totalTime ? time / totalTime : page / total;
        const elapsed = (performance.now() - started) / 1000;
        const eta = frac > 0.02 ? (elapsed / frac) * (1 - frac) : null;
        $('#progress-bar').style.width = `${(frac * 100).toFixed(1)}%`;
        $('#progress-text').textContent = `Página ${page} de ${total} · ${formatTime(time)} de ${formatTime(totalTime)} de vídeo${eta != null ? ` · faltam ~${formatTime(eta)}` : ''}`;
        tabProgress(frac, bookTitle);
      },
    });
    showResult(result, s);
    tabFinished(true, bookTitle);
    if ($('#s-notify').checked) notify('✅ Vídeo pronto!', `${bookTitle} · ${formatTime(result.duration)} · ${formatBytes(result.blob.size)}`);
  } catch (err) {
    if (err?.name === 'AbortError' || state.abort.signal.aborted) {
      tabReset();
      toast('Geração cancelada.');
    } else {
      console.error(err);
      tabFinished(false, bookTitle);
      if ($('#s-notify').checked) notify('⚠️ Erro ao gerar o vídeo', `${bookTitle}: ${err.message || err}`);
      toast(`Erro ao gerar o vídeo: ${err.message || err}`, 8000);
    }
  } finally {
    stopKeepAlive();
    wakeLock?.release?.().catch(() => {});
    state.busy = false;
    state.abort = null;
    document.body.classList.remove('busy');
    $('#progress-panel').hidden = true;
    $('#btn-generate').disabled = false;
  }
}

function showResult({ blob, codec, duration }, s) {
  const url = URL.createObjectURL(blob);
  state.resultUrl = url;
  const video = $('#result-video');
  video.src = url;
  video.style.aspectRatio = `${s.width} / ${s.height}`;
  const a = $('#btn-download');
  a.href = url;
  a.download = `${safeName(state.book.title)}.mp4`;
  $('#result-info').textContent = `${formatTime(duration)} · ${s.width}×${s.height} · ${codecLabel(codec)} · ${formatBytes(blob.size)}`;
  const warn = $('#result-warning');
  warn.hidden = codec === 'avc';
  if (codec !== 'avc') {
    warn.textContent = `Seu navegador não tem codificador H.264, então o vídeo foi gerado em ${codecLabel(codec)} (dentro de um arquivo MP4). Ele abre no VLC, Chrome, Firefox e na maioria das plataformas, mas pode não abrir em alguns aparelhos antigos. Para H.264, use Chrome ou Edge.`;
  }
  $('#result-panel').hidden = false;
  $('#result-panel').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function clearResult() {
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = null;
  const video = $('#result-video');
  video.removeAttribute('src');
  video.load();
  $('#result-panel').hidden = true;
}

function safeName(s) {
  return (s || 'livro').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'livro';
}
function formatBytes(n) {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} GB`;
}

let toastTimer = 0;
function toast(msg, ms = 4000) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

window.addEventListener('beforeunload', (e) => {
  if (state.busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});
