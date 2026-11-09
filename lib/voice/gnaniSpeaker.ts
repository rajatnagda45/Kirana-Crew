/**
 * Speaks Gemini Live's replies in the agent's own Gnani Timbre voice, and only that voice.
 *
 * Gemini Live still listens, understands, calls the NammaOps tools and writes the reply. Its own
 * audio is discarded. The reply text is cut into sentences as it streams in; each sentence is
 * requested from Gnani's streaming endpoint (via the server, which holds the API key) and its PCM
 * chunks are scheduled for playback as they arrive, so speech starts after the first chunk instead
 * of after the whole sentence. Sentences are fetched one at a time (Gnani allows one active
 * request) while the previous one is still playing, which keeps the speech gapless.
 */
export class GnaniSpeaker {
  private queue: string[] = [];
  private pumping = false;
  private sources = new Set<AudioBufferSourceNode>();
  private generation = 0;
  private pending = 0;
  private spoken = 0;
  private nextTime = 0;
  private controller = new AbortController();
  failed = false;
  /** Called each time audio is scheduled (the caller keeps the first per turn for latency timing). */
  onAudio: (() => void) | null = null;

  constructor(
    private context: AudioContext,
    private voice: string | null,
    private language = "en-IN",
    private onFailure?: (reason: string) => void,
  ) {}

  /** True while a sentence is being fetched or is still playing. */
  get speaking() {
    return this.pending > 0 || this.sources.size > 0;
  }

  /** Hand over every complete sentence of `text` that has not been spoken yet. */
  feed(text: string, final = false) {
    let rest = text.slice(this.spoken);
    for (;;) {
      const match = /^([\s\S]+?[.!?।]["')\]]*)(\s+|$)/.exec(rest);
      if (!match || (!final && !match[2])) break;
      this.say(match[1]);
      this.spoken += match[0].length;
      rest = rest.slice(match[0].length);
    }
    if (final && rest.trim()) {
      this.say(rest);
      this.spoken = text.length;
    }
  }

  /** Forget the finished reply so the next one starts counting from zero. */
  reset() {
    this.spoken = 0;
  }

  private say(sentence: string) {
    const text = sentence.replace(/\s+/g, " ").trim();
    if (!text || !/[A-Za-z0-9ऀ-෿]/.test(text)) return;
    this.queue.push(text);
    this.pending += 1;
    void this.pump();
  }

  /**
   * One request at a time (Gnani allows a single active request). Whatever sentences arrived while
   * the previous request was being fetched go out together as one request: one continuous
   * delivery, so there is no pause between them and the intonation runs across the sentences.
   * The first sentence still goes out alone, immediately, so speech starts as soon as possible.
   */
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const generation = this.generation;
    const signal = this.controller.signal;
    try {
      while (this.queue.length && generation === this.generation) {
        const batch = this.queue.splice(0, this.queue.length);
        try {
          await this.streamSentence(batch.join(" "), generation, signal);
        } catch (error) {
          if (generation === this.generation && !signal.aborted) {
            this.failed = true;
            this.onFailure?.(error instanceof Error ? error.message : "Gnani voice failed.");
          }
        } finally {
          if (generation === this.generation) this.pending -= batch.length;
        }
      }
    } finally {
      if (generation === this.generation) this.pumping = false;
    }
  }

  private async streamSentence(text: string, generation: number, signal: AbortSignal) {
    const response = await fetch("/api/runtime/voice/speak-stream", {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Origin: window.location.origin },
      body: JSON.stringify({
        text,
        language: this.language,
        ...(this.voice ? { voice: this.voice } : {}),
      }),
    });
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error ?? `Gnani voice unavailable (HTTP ${response.status}).`);
    }
    const rate = Number(response.headers.get("X-Sample-Rate")) || 24000;
    const reader = response.body.getReader();
    let carry: Uint8Array | null = null; // a PCM16 sample can straddle two network chunks
    for (;;) {
      const { value, done } = await reader.read();
      if (generation !== this.generation) {
        void reader.cancel().catch(() => {});
        return;
      }
      if (done) break;
      if (!value?.length) continue;
      let bytes = value;
      if (carry) {
        const merged = new Uint8Array(carry.length + value.length);
        merged.set(carry);
        merged.set(value, carry.length);
        bytes = merged;
        carry = null;
      }
      if (bytes.length % 2) {
        carry = bytes.slice(bytes.length - 1);
        bytes = bytes.slice(0, bytes.length - 1);
      }
      this.schedule(bytes, rate);
    }
  }

  /** Queue raw PCM16 mono for gapless playback. */
  private schedule(bytes: Uint8Array, rate: number) {
    const count = bytes.length / 2;
    if (!count) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const samples = new Float32Array(count);
    for (let i = 0; i < count; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const buffer = this.context.createBuffer(1, count, rate);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
    };
    const start = Math.max(this.context.currentTime + 0.03, this.nextTime);
    source.start(start);
    this.nextTime = start + buffer.duration;
    this.onAudio?.();
  }

  /** Cut off everything queued or playing (the owner interrupted, or the call ended). */
  stop() {
    this.generation += 1;
    this.controller.abort();
    this.controller = new AbortController();
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* already finished */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.pending = 0;
    this.spoken = 0;
    this.nextTime = 0;
    this.queue = [];
    this.pumping = false;
  }
}
