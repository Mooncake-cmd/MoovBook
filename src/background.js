// Conversão em segundo plano: mantém a aba "acordada", mostra o progresso no
// título e no ícone da aba e avisa quando o vídeo fica pronto.

// ------------------------------------------------------------ título e ícone da aba

const ACCENT = '#4f46e5';
const iconLink = document.querySelector('link[rel="icon"]');
const originalIcon = iconLink?.href;
let baseTitle = document.title;
let lastPct = -1;
let restoreTimer = 0;

function drawIcon(draw) {
  if (!iconLink) return;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  draw(c.getContext('2d'));
  iconLink.href = c.toDataURL('image/png');
}

function progressIcon(frac) {
  drawIcon((ctx) => {
    ctx.lineWidth = 12;
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(128, 128, 140, 0.35)';
    ctx.beginPath();
    ctx.arc(32, 32, 24, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = ACCENT;
    ctx.beginPath();
    ctx.arc(32, 32, 24, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.02, frac));
    ctx.stroke();
  });
}

function badgeIcon(color, glyph) {
  drawIcon((ctx) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(32, 32, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, 32, 35);
  });
}

/** Começa a mostrar o progresso na aba. `pageTitle` é o título normal, para restaurar no fim. */
export function tabStart(pageTitle, bookTitle) {
  clearTimeout(restoreTimer);
  document.removeEventListener('visibilitychange', restoreWhenVisible);
  baseTitle = pageTitle;
  lastPct = -1;
  tabProgress(0, bookTitle);
}

/** Atualiza a aba, ex.: "⏳ 37% · Dom Casmurro — MoovBook". */
export function tabProgress(frac, bookTitle) {
  const pct = Math.max(0, Math.min(100, Math.floor(frac * 100)));
  if (pct === lastPct) return;
  lastPct = pct;
  document.title = `⏳ ${pct}% · ${bookTitle} — MoovBook`;
  progressIcon(pct / 100);
}

/** Mostra "✅ Vídeo pronto!" (ou um erro) até a pessoa voltar para a aba. */
export function tabFinished(ok, bookTitle) {
  document.title = ok ? `✅ Vídeo pronto! · ${bookTitle}` : `⚠️ Erro na conversão · ${bookTitle}`;
  if (ok) badgeIcon('#16a34a', '✓');
  else badgeIcon('#dc2626', '!');
  if (document.hidden) document.addEventListener('visibilitychange', restoreWhenVisible);
  else restoreTimer = setTimeout(tabReset, 6000);
}

function restoreWhenVisible() {
  if (document.hidden) return;
  document.removeEventListener('visibilitychange', restoreWhenVisible);
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(tabReset, 6000);
}

/** Volta o título e o ícone normais. */
export function tabReset() {
  clearTimeout(restoreTimer);
  document.removeEventListener('visibilitychange', restoreWhenVisible);
  document.title = baseTitle;
  if (iconLink && originalIcon) iconLink.href = originalIcon;
}

// ------------------------------------------------------------ notificação

export const notificationsSupported = typeof window !== 'undefined' && 'Notification' in window;

/** Pede permissão (deve ser chamado num clique). Retorna true se permitido. */
export async function requestNotificationPermission() {
  if (!notificationsSupported) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/** Mostra a notificação só se a aba estiver em segundo plano. */
export function notify(title, body) {
  if (!notificationsSupported || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(title, { body, icon: originalIcon, tag: 'moovbook' });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* alguns navegadores (ex.: Chrome no Android) só notificam via service worker */
  }
}

// ------------------------------------------------------------ áudio que mantém a aba acordada

let audioCtx = null;
let oscillator = null;

/**
 * Toca um som inaudível enquanto o vídeo é gerado. O Chrome não congela nem
 * limita abas que estão tocando áudio (é por isso que uma música continua
 * tocando em outra aba). O som tem 20 Hz e volume de -60 dB: abaixo do que o
 * ouvido humano percebe, mas acima do limite que o Chrome considera "silêncio".
 * Efeito visível: um ícone de alto-falante aparece na aba durante a conversão.
 *
 * Deve ser chamado logo após um clique do usuário (o navegador exige isso).
 */
export function startKeepAlive() {
  if (audioCtx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = new AC();
    oscillator = audioCtx.createOscillator();
    oscillator.frequency.value = 20;
    const gain = audioCtx.createGain();
    gain.gain.value = 0.001;
    oscillator.connect(gain).connect(audioCtx.destination);
    oscillator.start();
    audioCtx.resume?.().catch(() => {});
  } catch {
    stopKeepAlive(); // sem áudio disponível: a conversão segue normalmente
  }
}

export function stopKeepAlive() {
  try {
    oscillator?.stop();
  } catch {
    /* já parado */
  }
  audioCtx?.close?.().catch(() => {});
  audioCtx = null;
  oscillator = null;
}
