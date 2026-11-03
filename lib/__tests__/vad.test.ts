import { describe, expect, it } from "vitest";
import { VAD, createVadCore, type VadEvent } from "../voice/vad-core";

const RATE = 48000;
const FRAME = VAD.frame;
const frameSeconds = FRAME / RATE;

/** One frame of a 180 Hz tone ("voice") or noise at a given RMS level. */
function frame(rms: number, kind: "tone" | "noise" = "tone", phase = 0): Float32Array {
  const out = new Float32Array(FRAME);
  let seed = phase + 1;
  for (let i = 0; i < FRAME; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = (seed / 4294967296) * 2 - 1;
    out[i] =
      kind === "tone"
        ? Math.sin((2 * Math.PI * 180 * (i + phase * FRAME)) / RATE) * rms * Math.SQRT2
        : noise * rms * Math.sqrt(3);
  }
  return out;
}
const frames = (seconds: number) => Math.round(seconds / frameSeconds);

function run(
  plan: Array<[seconds: number, rms: number, kind?: "tone" | "noise"]>,
  suppressedAt?: (index: number) => boolean,
) {
  const core = createVadCore(RATE);
  const events: VadEvent[] = [];
  let index = 0;
  for (const [seconds, rms, kind] of plan)
    for (let i = 0; i < frames(seconds); i++, index++)
      events.push(...core.push(frame(rms, kind, index), suppressedAt?.(index) ?? false));
  return { core, events };
}
const types = (events: VadEvent[]) => events.map((e) => e.type);

describe("local voice-activity detection", () => {
  it("sends nothing for silence or steady room noise", () => {
    const { events, core } = run([
      [10, 0.0005, "noise"],
      [10, 0.006, "noise"],
    ]);
    expect(events).toEqual([]);
    expect(core.hearing).toBe(false);
  });

  it("cuts one utterance out of a sentence, with pre-roll and without the trailing silence", () => {
    const { events } = run([
      [1, 0.004, "noise"],
      [1.5, 0.08],
      [2, 0.004, "noise"],
    ]);
    expect(types(events)).toEqual(["start", "utterance"]);
    const utterance = events.find((e) => e.type === "utterance") as Extract<
      VadEvent,
      { type: "utterance" }
    >;
    expect(utterance.voicedSeconds).toBeGreaterThan(1.3);
    const seconds = utterance.frames.length * frameSeconds;
    // ~0.35 s pre-roll + 1.5 s speech + ~0.8 s hang-over; never the whole 4.5 s recording.
    expect(seconds).toBeGreaterThan(1.9);
    expect(seconds).toBeLessThan(3.2);
  });

  it("keeps a short pause inside one utterance but splits on a long one", () => {
    const sentence = run([
      [1, 0.004, "noise"],
      [1, 0.08],
      [0.4, 0.004, "noise"],
      [1, 0.08],
      [2, 0.004, "noise"],
    ]);
    expect(types(sentence.events)).toEqual(["start", "utterance"]);
    const two = run([
      [1, 0.004, "noise"],
      [1, 0.08],
      [1.5, 0.004, "noise"],
      [1, 0.08],
      [2, 0.004, "noise"],
    ]);
    expect(types(two.events)).toEqual(["start", "utterance", "start", "utterance"]);
  });

  it("drops clicks and coughs that are too short to be speech", () => {
    const { events } = run([
      [1, 0.004, "noise"],
      [0.12, 0.2],
      [2, 0.004, "noise"],
    ]);
    expect(events.some((e) => e.type === "utterance")).toBe(false);
  });

  it("closes an unbroken utterance at the 15 second cap", () => {
    const { events } = run([
      [1, 0.004, "noise"],
      [20, 0.08],
    ]);
    const first = events.find((e) => e.type === "utterance") as Extract<
      VadEvent,
      { type: "utterance" }
    >;
    expect(first.frames.length * frameSeconds).toBeLessThanOrEqual(
      VAD.maxUtteranceSeconds + frameSeconds,
    );
  });

  it("adapts to a noisy room instead of triggering on it", () => {
    // Fan noise at 0.012 RMS is above the quiet default; after a moment it is the floor.
    const { events } = run([
      [8, 0.012, "noise"],
      [1, 0.12],
      [2, 0.012, "noise"],
    ]);
    expect(types(events)).toEqual(["start", "utterance"]);
  });

  it("ignores speech while the assistant is talking, and reports barge-in only for loud sustained talk-over", () => {
    const quiet = run(
      [
        [1, 0.004, "noise"],
        [3, 0.03],
      ],
      () => true,
    );
    expect(quiet.events).toEqual([]); // faint echo of the speaker: ignored
    const loud = run(
      [
        [1, 0.004, "noise"],
        [3, 0.15],
      ],
      (i) => i >= frames(1),
    );
    expect(types(loud.events)).toContain("barge-in");
    expect(loud.events.some((e) => e.type === "utterance")).toBe(false);
  });

  it("resumes listening normally after the assistant finishes", () => {
    const { events } = run(
      [
        [1, 0.004, "noise"],
        [2, 0.03],
        [1, 0.004, "noise"],
        [1.2, 0.08],
        [2, 0.004, "noise"],
      ],
      (i) => i >= frames(1) && i < frames(3),
    );
    expect(types(events)).toEqual(["start", "utterance"]);
  });
});

describe("live voice cost", () => {
  it("uploads speech only: a minute with 5 s of speech sends about 8% of a continuous stream", () => {
    const { events } = run([
      [20, 0.004, "noise"],
      [3, 0.08],
      [17, 0.004, "noise"],
      [2, 0.08],
      [18, 0.004, "noise"],
    ]);
    const sent = events
      .filter((e): e is Extract<VadEvent, { type: "utterance" }> => e.type === "utterance")
      .reduce((s, e) => s + e.frames.length * frameSeconds, 0);
    expect(sent).toBeLessThan(60 * 0.2); // far below streaming the whole minute
    expect(sent).toBeGreaterThan(5);
  });
});
