"use client";

import { useEffect, useState } from "react";

const SHELVES = [
  { label: "Milk", fill: 0.6, color: "#6fb3e8" },
  { label: "Oil", fill: 0.15, color: "#e07a4a", low: true },
  { label: "Rice", fill: 0.85, color: "#43e58a" },
  { label: "Sugar", fill: 0.45, color: "#d9ad24" },
];

export function InventoryIllustration() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const id = setInterval(() => setTick((t) => t + 1), 900);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto h-20 w-full max-w-[180px] select-none rounded-sm border border-[#494033] bg-[#12110F] p-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-pixel text-[5px] text-[#f0c13a]">STOCK LEVELS</span>
        <span
          className="font-pixel text-[5px]"
          style={{ color: tick % 2 === 0 ? "#43e58a" : "#888" }}
        >
          LIVE
        </span>
      </div>
      <div className="space-y-1.5">
        {SHELVES.map((s) => (
          <div key={s.label} className="flex items-center gap-1.5">
            <span
              className="w-8 font-mono text-[6px]"
              style={{ color: s.low ? "#e05c5c" : "#a99d89" }}
            >
              {s.label}
            </span>
            <div className="relative h-2 flex-1 rounded-none bg-[#2a2420]">
              <div
                className="h-full transition-all duration-700"
                style={{ width: `${s.fill * 100}%`, background: s.low ? "#e05c5c" : s.color }}
              />
            </div>
            {s.low && <span className="font-pixel text-[5px] text-[#e05c5c]">!</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
