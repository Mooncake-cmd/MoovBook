// Codificação do vídeo MP4 no próprio navegador (WebCodecs + Mediabunny).

import {
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, getFirstEncodableVideoCodec,
  QUALITY_MEDIUM, QUALITY_HIGH, QUALITY_VERY_HIGH,
} from 'mediabunny';

const QUALITIES = { medium: QUALITY_MEDIUM, high: QUALITY_HIGH, veryhigh: QUALITY_VERY_HIGH };
const CODEC_NAMES = { avc: 'H.264', hevc: 'H.265/HEVC', vp9: 'VP9', av1: 'AV1' };

export function webCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

export async function pickCodec(width, height, quality = 'high') {
  if (!webCodecsAvailable()) return null;
  return getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height, quality: QUALITIES[quality] });
}

export function codecLabel(codec) {
  return CODEC_NAMES[codec] || codec;
}

/**
 * Gera o MP4.
 * @param {{
 *   doc: ReturnType<import('./render.js').buildDocument>,
 *   slides: number[],               // índices dos quadros a incluir, em ordem
 *   durationOf: (slide:number)=>Promise<number>|number,
 *   fps: number,
 *   transition: number,             // segundos de fade entre páginas (0 = corte seco)
 *   quality: 'medium'|'high'|'veryhigh',
 *   onProgress: (info:{slide:number, page:number, total:number, time:number, totalTime:number})=>void,
 *   signal?: AbortSignal,
 * }} o
 * @returns {Promise<{blob: Blob, codec: string, duration: number}>}
 */
export async function encodeVideo(o) {
  const { doc, slides, fps } = o;
  const W = doc.width;
  const H = doc.height;
  const codec = await pickCodec(W, H, o.quality);
  if (!codec) throw new Error('Seu navegador não consegue codificar vídeo nesta resolução. Use uma versão recente do Chrome, Edge, Safari ou Firefox, ou escolha uma resolução menor.');

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });

  // Quadro anterior, usado na transição com fade
  const prev = document.createElement('canvas');
  prev.width = W;
  prev.height = H;
  const prevCtx = prev.getContext('2d', { alpha: false });
  const next = document.createElement('canvas');
  next.width = W;
  next.height = H;
  const nextCtx = next.getContext('2d', { alpha: false });

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, {
    codec,
    bitrate: QUALITIES[o.quality] || QUALITY_HIGH,
    // as páginas são estáticas: quadros-chave a cada 10 s bastam (e forçamos um a cada página)
    keyFrameInterval: 10,
    latencyMode: 'quality',
  });
  output.addVideoTrack(source, { frameRate: fps });

  const abort = () => output.cancel().catch(() => {});
  o.signal?.addEventListener('abort', abort, { once: true });

  try {
    await output.start();

    const durations = [];
    for (const s of slides) durations.push(Math.max(0.1, Number(await o.durationOf(s)) || 0));
    const totalTime = durations.reduce((a, b) => a + b, 0);
    const frameDur = 1 / fps;

    let t = 0;
    let frameNo = 0;
    for (let k = 0; k < slides.length; k++) {
      if (o.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
      const dur = durations[k];
      // quantidade de quadros desta página (arredondando no tempo global evita deriva)
      const endFrame = Math.round((t + dur) * fps);
      const frames = Math.max(1, endFrame - frameNo);

      nextCtx.setTransform(1, 0, 0, 1, 0, 0);
      await doc.drawSlide(nextCtx, slides[k], 1);

      const fadeFrames = k > 0 && o.transition > 0 ? Math.min(frames - 1, Math.round(o.transition * fps)) : 0;
      for (let f = 0; f < frames; f++) {
        if (f < fadeFrames) {
          const a = (f + 1) / (fadeFrames + 1);
          ctx.globalAlpha = 1;
          ctx.drawImage(prev, 0, 0);
          ctx.globalAlpha = a;
          ctx.drawImage(next, 0, 0);
          ctx.globalAlpha = 1;
        } else if (f === fadeFrames) {
          ctx.drawImage(next, 0, 0);
        }
        await source.add(frameNo * frameDur, frameDur, { keyFrame: f === 0 || f === fadeFrames });
        frameNo++;
        if ((f & 7) === 0 && o.signal?.aborted) throw new DOMException('Cancelado', 'AbortError');
        // progresso também no meio da página (a cada segundo de vídeo)
        if (frameNo % Math.max(1, Math.round(fps)) === 0 && f < frames - 1) {
          o.onProgress?.({ slide: slides[k], page: k + 1, total: slides.length, time: frameNo * frameDur, totalTime });
        }
      }
      t += dur;
      prevCtx.drawImage(next, 0, 0);
      o.onProgress?.({ slide: slides[k], page: k + 1, total: slides.length, time: t, totalTime });
    }

    await output.finalize();
    const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
    return { blob, codec, duration: totalTime };
  } catch (e) {
    abort();
    throw e;
  } finally {
    o.signal?.removeEventListener('abort', abort);
    canvas.width = prev.width = next.width = 0;
  }
}
