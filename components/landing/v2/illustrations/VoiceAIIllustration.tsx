"use client";

import { useEffect, useState } from "react";

const WAVE_HEIGHTS = [0.3, 0.7, 0.5, 1, 0.6, 0.85, 0.4, 0.75, 0.55, 0.9];

export function VoiceAIIllustration() {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const id = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto h-20 w-full max-w-[180px] select-none rounded-sm border border-[#494033] bg-[#12110F] p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-pixel text-[5px] text-[#e05c5c]">GNANI VOICE</span>
        <span className="font-pixel text-[5px] text-[#a99d89]">STT · TTS</span>
      </div>
      {/* Waveform */}
      <div className="flex h-8 items-center justify-center gap-px px-2">
        {WAVE_HEIGHTS.map((h, i) => {
          const animated = Math.abs(Math.sin(frame * 0.3 + i * 0.8)) * h;
          return (
            <div
              key={i}
              className="w-1.5 rounded-none"
              style={{
                height: `${Math.max(0.15, animated) * 100}%`,
                background: i % 2 === 0 ? "#e05c5c" : "#f0c13a",
                opacity: 0.8,
              }}
            />
          );
        })}
      </div>
      {/* Language tags */}
      <div className="mt-1 flex justify-center gap-1.5">
        {["ಕನ್ನಡ", "हिंदी", "English"].map((lang) => (
          <span
            key={lang}
            className="rounded-none border border-[#3a2a20] px-1 py-0.5 font-mono text-[5px] text-[#6b5f52]"
          >
            {lang}
          </span>
        ))}
      </div>
    </div>
  );
}
