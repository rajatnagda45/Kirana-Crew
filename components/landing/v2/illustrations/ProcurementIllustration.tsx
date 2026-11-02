"use client";

import { useEffect, useState } from "react";

const SUPPLIERS = [
  { name: "Shree Dist.", price: "₹40/pk", best: true },
  { name: "Kumar & Co", price: "₹44/pk", best: false },
  { name: "Metro Cash", price: "₹42/pk", best: false },
];

export function ProcurementIllustration() {
  const [highlighted, setHighlighted] = useState(0);

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;
    const id = setInterval(() => setHighlighted((h) => (h + 1) % SUPPLIERS.length), 1100);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto h-20 w-full max-w-[180px] select-none rounded-sm border border-[#494033] bg-[#12110F] p-2">
      <div className="mb-1.5 font-pixel text-[5px] text-[#f0c13a]">SUPPLIER COMPARE</div>
      <div className="space-y-1.5">
        {SUPPLIERS.map((s, i) => (
          <div
            key={s.name}
            className="flex items-center justify-between rounded-none px-1 py-0.5 transition-colors duration-300"
            style={{
              background: i === highlighted ? "rgba(240,193,58,0.08)" : "transparent",
              border: s.best ? "1px solid rgba(67,229,138,0.3)" : "1px solid transparent",
            }}
          >
            <span
              className="font-mono text-[6px]"
              style={{ color: s.best ? "#43e58a" : "#a99d89" }}
            >
              {s.name}
            </span>
            <span
              className="font-pixel text-[6px]"
              style={{ color: s.best ? "#43e58a" : "#6b5f52" }}
            >
              {s.price}
            </span>
            {s.best && <span className="font-pixel text-[5px] text-[#43e58a]">✓</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
