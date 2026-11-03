"use client";
/**
 * Local voice-activity detection for hands-free voice. It runs entirely in the browser (no API
 * calls, no cost): the detector in vad-core.ts cuts the microphone stream into utterances, and
 * only an utterance with real speech is ever sent to speech-to-text. Silence, room noise, short
 * clicks and pauses are never uploaded or billed.
 *
 * - pre-roll keeps ~0.35 s before speech started, so the first word is not clipped
 * - ~0.8 s of quiet ends an utterance, so a short pause mid-sentence does not cut it
 * - clips with under ~0.4 s of voiced audio are dropped; utterances are capped at 15 s
 * - barge-in: while the assistant talks, sustained loud speech interrupts it
 */
import { createVadCore, frameRms, VAD } from "@/lib/voice/vad-core";
import { downsample, encodeWav, TARGET_SAMPLE_RATE } from "@/lib/voice/wavRecorder";

export { VAD };

export interface VadHandle {
  stop: () => void;
  /** While true, speech is ignored (the assistant is talking) except for barge-in. */
  setSuppressed: (value: boolean) => void;
}

export interface VadOptions {
  /** A finished utterance as 16 kHz mono WAV, with its voiced duration in seconds. */
  onUtterance: (wav: Blob, voicedSeconds: number) => void;
  onSpeechStart?: () => void;
  /** Called while suppressed when the user clearly talks over the assistant. */
  onBargeIn?: () => void;
  /** Live level 0..1 and whether speech is being heard, about 20 times a second. */
  onLevel?: (level: number, hearing: boolean) => void;
}

export async function startVad(options: VadOptions): Promise<VadHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but universally available and needs no worklet file.
  const processor = context.createScriptProcessor(VAD.frame, 1, 1);
  const rate = context.sampleRate;
  const core = createVadCore(rate);
  let suppressed = false;
  let closed = false;
  let tick = 0;

  processor.onaudioprocess = (event) => {
    if (closed) return;
    const frame = new Float32Array(event.inputBuffer.getChannelData(0));
    for (const e of core.push(frame, suppressed)) {
      if (e.type === "start") options.onSpeechStart?.();
      else if (e.type === "barge-in") options.onBargeIn?.();
      else if (e.type === "utterance") {
        const all = new Float32Array(e.frames.reduce((n, f) => n + f.length, 0));
        let offset = 0;
        for (const f of e.frames) {
          all.set(f, offset);
          offset += f.length;
        }
        // No synthetic lead-in: the real pre-roll is already at the start of the clip.
        options.onUtterance(
          encodeWav(downsample(all, rate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE, 0),
          e.voicedSeconds,
        );
      }
    }
    tick += 1;
    if (tick % 2 === 0) options.onLevel?.(Math.min(1, frameRms(frame) * 8), core.hearing);
  };

  source.connect(processor);
  processor.connect(context.destination);

  return {
    setSuppressed(value) {
      if (value && !suppressed) core.reset();
      suppressed = value;
    },
    stop() {
      if (closed) return;
      closed = true;
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}
