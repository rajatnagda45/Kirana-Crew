"use client";

import { useEffect, useState } from "react";

const BARS = [0.4, 0.6, 0.5, 0.75, 0.65, 0.9, 0.8];
const DAYS = ["M", "T", "W", "T", "F", "S", "S"];

export function SalesIllustration() {
  const [active, setActive] = useState(6);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const id = setInterval(() => setActive((a) => (a === 0 ? 6 : a - 1)), 700);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto h-20 w-full max-w-[180px] select-none rounded-sm border border-[#494033] bg-[#12110F] p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-pixel text-[5px] text-[#f0c13a]">WEEKLY SALES</span>
        <span className="font-mono text-[6px] text-[#43e58a]">↑ 12%</span>
      </div>
      <div className="flex h-10 items-end gap-1 px-1">
        {BARS.map((h, i) => (
          <div key={i} className="flex flex-1 flex-col items-center gap-0.5">
            <div
              className="w-full transition-all duration-500"
              style={{
                height: `${h * 100}%`,
                background: i === active ? "#d9ad24" : "#3f6aa8",
                opacity: i === active ? 1 : 0.6,
              }}
            />
            <span className="font-mono text-[5px] text-[#494033]">{DAYS[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
