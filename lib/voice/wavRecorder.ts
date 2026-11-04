"use client";
/**
 * Microphone -> 16 kHz mono 16-bit WAV, for Gnani Prisma speech-to-text.
 * No dependencies: Web Audio capture, linear downsampling and a WAV header. A short silence
 * lead-in is added because the recogniser tends to drop the first word of a clip.
 */
const TARGET_RATE = 16000;
const LEAD_IN_SECONDS = 0.3;
export const MAX_RECORDING_MS = 30_000;
export const TARGET_SAMPLE_RATE = TARGET_RATE;

export interface WavRecording {
  stop: () => Promise<Blob>;
  cancel: () => void;
}

export function downsample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    // Average the source samples that fall into this output sample (simple low-pass).
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = end > start ? sum / (end - start) : (input[start] ?? 0);
  }
  return out;
}

export function encodeWav(
  samples: Float32Array,
  rate: number,
  leadInSeconds = LEAD_IN_SECONDS,
): Blob {
  const lead = Math.round(rate * leadInSeconds);
  const total = lead + samples.length;
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) =>
    [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, total * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + (lead + i) * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Starts recording; throws a DOMException (e.g. NotAllowedError) if the mic is refused. */
export async function startWavRecording(onAutoStop?: () => void): Promise<WavRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but universally available and needs no worklet file.
  const processor = context.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (event) =>
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  source.connect(processor);
  processor.connect(context.destination);
  const timer = setTimeout(() => onAutoStop?.(), MAX_RECORDING_MS);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    processor.disconnect();
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };
  return {
    async stop() {
      const rate = context.sampleRate;
      close();
      const length = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        all.set(chunk, offset);
        offset += chunk.length;
      }
      return encodeWav(downsample(all, rate, TARGET_RATE), TARGET_RATE);
    },
    cancel: close,
  };
}

export interface Playback {
  done: Promise<void>;
  stop: () => void;
}

/** Plays a base64 audio clip; `stop()` cuts it off (barge-in) and resolves `done`. */
export function playClip(base64: string, mime: string): Playback {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const audio = new Audio(url);
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
  });
  audio.onended = finish;
  audio.onerror = finish;
  void audio.play().catch(finish);
  return {
    done,
    stop: () => {
      audio.pause();
      finish();
    },
  };
}

/** Plays a base64 audio clip; resolves when playback ends. */
export function playBase64Audio(base64: string, mime: string): Promise<void> {
  return playClip(base64, mime).done;
}
