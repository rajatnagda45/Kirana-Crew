"use client";

import { useState } from "react";
import { ArrowRight, RotateCcw, Download, Check, FileText } from "lucide-react";
import { Button } from "./Button";
import { demoStages, eventsAtStage, nextDemoStage, samplePrompt, sampleReport } from "./demo";
import { walkthroughMeta } from "./kiranacrew-content";

const agentAssignments = [
  { name: "Manager Agent", role: "Coordinate crew" },
  { name: "Inventory Agent", role: "Check stock" },
  { name: "Sales Agent", role: "Review demand" },
  { name: "Procurement Agent", role: "Draft order" },
];

function agentStatus(agentName: string, stage: number) {
  if (stage === 0) return "Awaiting task";
  if (stage === 1) {
    if (agentName === "Manager Agent") return "Delegating";
    return "Assigned";
  }
  if (stage === 2) {
    if (agentName === "Manager Agent") return "Monitoring";
    return "Working";
  }
  return "Completed";
}

export function TaskWalkthrough() {
  const [stage, setStage] = useState(0);
  const events = eventsAtStage(stage);
  const download = () => {
    const url = URL.createObjectURL(new Blob([sampleReport], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "kiranacrew-sample-order.txt";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section id="live-task" className="mx-auto max-w-7xl scroll-mt-28 px-6 pb-24">
      <div className="mb-12 text-center">
        <p className="font-pixel text-[9px] tracking-[0.2em] text-gold">{walkthroughMeta.label}</p>
        <h2 className="mt-5 text-3xl font-bold text-cream lg:text-4xl">
          {walkthroughMeta.heading}
        </h2>
        <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
          {walkthroughMeta.sub}
        </p>
      </div>
      <div className="border border-border bg-deep">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-5 py-3">
          <span className="flex items-center gap-2 text-xs text-gold">
            <span className="h-1.5 w-1.5 bg-gold" />
            {walkthroughMeta.demoLabel}
          </span>
          <span className="text-xs text-muted-foreground">{walkthroughMeta.demoSub}</span>
        </div>
        <div className="grid grid-cols-4 border-b border-border" aria-label="Workflow stages">
          {demoStages.map((name, i) => (
            <Button
              key={name}
              variant="ghost"
              onClick={() => setStage(i)}
              aria-current={stage === i ? "step" : undefined}
              className={`h-14 w-full rounded-none border-r border-border px-1 text-[11px] sm:text-sm ${stage === i ? "bg-burgundy text-gold" : "text-muted-foreground"}`}
            >
              <span className="hidden sm:inline">{i + 1}.</span>
              {name}
              {i < stage && <Check className="hidden sm:block h-3 w-3" />}
            </Button>
          ))}
        </div>
        <div className="grid lg:grid-cols-[0.8fr_1.2fr]">
          <div className="min-w-0 border-b border-border p-6 sm:p-8 lg:border-b-0 lg:border-r">
            <p className="text-[10px] uppercase text-muted-foreground">Voice command</p>
            <p className="mt-3 text-base leading-relaxed text-cream">
              &ldquo;{samplePrompt}&rdquo;
            </p>
            <div className="mt-3 rounded-sm border border-border bg-surface px-3 py-2 text-[10px] text-muted-foreground">
              <span className="text-crimson">Gnani Prisma STT</span>
              {" · "}
              Intent: <span className="text-gold">prepare_reorder</span>
              {" · "}
              Products: <span className="text-cream">[milk, oil]</span>
            </div>
            <div className="mt-6 space-y-3 border-t border-border pt-5">
              {agentAssignments.map((a) => (
                <div
                  key={a.name}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs"
                >
                  <span className="text-cream">
                    {a.name}
                    <span className="ml-2 text-muted-foreground">{a.role}</span>
                  </span>
                  <span className="text-gold">{agentStatus(a.name, stage)}</span>
                </div>
              ))}
            </div>
            <div className="mt-8 flex items-center gap-3">
              <Button
                onClick={() => setStage(nextDemoStage(stage))}
                disabled={stage === 3}
                className="h-10 rounded-sm"
              >
                Next step <ArrowRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                onClick={() => setStage(0)}
                aria-label="Replay walkthrough"
                title="Replay walkthrough"
              >
                <RotateCcw className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="min-w-0 p-6 sm:p-8">
            <div className="flex items-center justify-between text-xs">
              <span className="text-gold">WORKFLOW EVENTS</span>
              <span className="text-muted-foreground">{stage + 1} / 4</span>
            </div>
            <ol
              className="mt-5 min-h-80 space-y-5 border-l border-border pl-5"
              aria-live="polite"
              aria-label="Sample workflow timeline"
            >
              {events.map((e, i) => (
                <li key={e.action} className="relative">
                  <span className="absolute -left-[25px] top-1 h-2 w-2 bg-gold" />
                  <p className="text-[10px] text-muted-foreground">
                    {String(i + 1).padStart(2, "0")} / {e.agent}
                  </p>
                  <p className="mt-1 text-sm font-bold text-cream">{e.action}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{e.detail}</p>
                </li>
              ))}
            </ol>
          </div>
        </div>
        {stage === 3 && (
          <div className="border-t border-border p-6 sm:p-8" id="sample-output">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="flex items-center gap-2 font-bold text-cream">
                <FileText className="h-4 w-4 text-gold" />
                Draft purchase order ready
              </h3>
              <Button variant="outline" onClick={download}>
                <Download className="h-4 w-4" />
                Download sample PO
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Illustrative output · owner PIN approval required before any ERP write.
            </p>
            <pre className="mt-5 whitespace-pre-wrap break-words border-l-2 border-crimson bg-surface p-4 text-xs leading-relaxed text-cream">
              {sampleReport}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
