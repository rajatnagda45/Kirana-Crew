/**
 * Pure voice-activity-detection state machine (no browser APIs), so the thresholds can be tested
 * with synthetic audio. `lib/voice/vad.ts` feeds it microphone frames.
 *
 * Energy detector with an adaptive noise floor. See vad.ts for the design notes.
 */
export const VAD = Object.freeze({
  frame: 2048, // samples per analysis frame (~43 ms at 48 kHz)
  minFloor: 0.004,
  maxFloor: 0.05,
  onFactor: 3.2, // start threshold = floor x this (and at least onMin)
  offFactor: 2.0, // end threshold = floor x this (and at least offMin)
  onMin: 0.018,
  offMin: 0.011,
  startFrames: 2, // consecutive loud frames to call it speech
  prerollSeconds: 0.35,
  hangoverSeconds: 0.8,
  minSpeechSeconds: 0.4,
  maxUtteranceSeconds: 15,
  bargeInMin: 0.06,
  bargeInSeconds: 0.3,
});

export type VadEvent =
  | { type: "start" }
  | { type: "barge-in" }
  | { type: "utterance"; frames: Float32Array[]; voicedSeconds: number }
  | { type: "dropped"; voicedSeconds: number };

export const frameRms = (frame: Float32Array) => {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
};

export function createVadCore(sampleRate: number) {
  const frameSeconds = VAD.frame / sampleRate;
  const prerollFrames = Math.ceil(VAD.prerollSeconds / frameSeconds);
  const hangoverFrames = Math.ceil(VAD.hangoverSeconds / frameSeconds);
  const maxFrames = Math.ceil(VAD.maxUtteranceSeconds / frameSeconds);
  const bargeFrames = Math.ceil(VAD.bargeInSeconds / frameSeconds);

  let floor = 0.01;
  let speaking = false;
  let loudRun = 0;
  let quietRun = 0;
  let voicedFrames = 0;
  let bargeRun = 0;
  let utterance: Float32Array[] = [];
  const preroll: Float32Array[] = [];

  const finish = (): VadEvent => {
    const frames = utterance;
    const voicedSeconds = voicedFrames * frameSeconds;
    utterance = [];
    speaking = false;
    loudRun = quietRun = voicedFrames = 0;
    // Too short to be speech (a click, a cough): never sent anywhere.
    return voicedSeconds < VAD.minSpeechSeconds
      ? { type: "dropped", voicedSeconds }
      : { type: "utterance", frames, voicedSeconds };
  };

  return {
    get hearing() {
      return speaking;
    },
    get noiseFloor() {
      return floor;
    },
    reset() {
      speaking = false;
      utterance = [];
      preroll.length = 0;
      loudRun = quietRun = voicedFrames = bargeRun = 0;
    },
    /** Feed one frame. While `suppressed` (assistant talking) only barge-in can fire. */
    push(frame: Float32Array, suppressed = false): VadEvent[] {
      const level = frameRms(frame);
      const events: VadEvent[] = [];
      if (suppressed) {
        speaking = false;
        utterance = [];
        preroll.length = 0;
        loudRun = quietRun = voicedFrames = 0;
        bargeRun = level > Math.max(VAD.bargeInMin, floor * 6) ? bargeRun + 1 : 0;
        if (bargeRun >= bargeFrames) {
          bargeRun = 0;
          events.push({ type: "barge-in" });
        }
        return events;
      }
      bargeRun = 0;
      const on = Math.max(VAD.onMin, floor * VAD.onFactor);
      const off = Math.max(VAD.offMin, floor * VAD.offFactor);
      if (!speaking) {
        // Adapt the noise floor only while it is quiet.
        if (level < on)
          floor = Math.min(VAD.maxFloor, Math.max(VAD.minFloor, floor * 0.95 + level * 0.05));
        preroll.push(frame);
        if (preroll.length > prerollFrames) preroll.shift();
        loudRun = level >= on ? loudRun + 1 : 0;
        if (loudRun >= VAD.startFrames) {
          speaking = true;
          utterance = [...preroll];
          voicedFrames = loudRun;
          quietRun = 0;
          preroll.length = 0;
          events.push({ type: "start" });
        }
      } else {
        utterance.push(frame);
        if (level >= off) {
          voicedFrames += 1;
          quietRun = 0;
        } else quietRun += 1;
        if (quietRun >= hangoverFrames || utterance.length >= maxFrames) events.push(finish());
      }
      return events;
    },
  };
}
