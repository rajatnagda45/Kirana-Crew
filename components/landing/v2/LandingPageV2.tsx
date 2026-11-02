"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Play, Rocket, Mic, Github, Volume2, Package } from "lucide-react";
import { TaskWalkthrough } from "./TaskWalkthrough";
import { Architecture } from "./Architecture";
import { initialWorkers, summarizeWorkers } from "./status";
import { OfficeCanvas } from "./OfficeCanvas";
import { PixelCharacter } from "./PixelCharacter";
import { InventoryIllustration } from "./illustrations/InventoryIllustration";
import { ProcurementIllustration } from "./illustrations/ProcurementIllustration";
import { SalesIllustration } from "./illustrations/SalesIllustration";
import { VoiceAIIllustration } from "./illustrations/VoiceAIIllustration";
import type { CharDef } from "./PixelCharacter";
import {
  brand,
  nav,
  features,
  stats,
  agentCrew,
  howItWorksSteps,
  voiceBanner,
  gnaniSection,
  gnaniAttribution,
  footerNav,
} from "./kiranacrew-content";

const CHAR_DEFS: Record<string, CharDef> = {
  Alice: { hair: "#6b3f22", skin: "#f1c7a0", shirt: "#3b4a7a", pants: "#2a2a3a" },
  Bob: { hair: "#8a5a32", skin: "#f1c7a0", shirt: "#3f8a5a", pants: "#4a4a58" },
  Carol: { hair: "#a3462c", skin: "#e9b88f", shirt: "#2f8a8a", pants: "#c46a2a", cap: "#a93640" },
  Dave: { hair: "#4a5a7a", skin: "#f3d0b0", shirt: "#6a4a8a", pants: "#3a4a3a" },
};

// Feature card illustrations mapped by tag
const FEATURE_ILLUS: Record<string, React.ComponentType> = {
  INVENTORY: InventoryIllustration,
  PROCUREMENT: ProcurementIllustration,
  SALES: SalesIllustration,
  "VOICE AI": VoiceAIIllustration,
};

// Stat icons
const STAT_ICONS = [Rocket, Volume2, Mic, Package];

// CTA crew (first 4 for avatar strip)
const ctaCrew = agentCrew.slice(0, 4);

function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [on, setOn] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => e?.isIntersecting && (setOn(true), io.disconnect()),
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, cls: on ? "animate-reveal" : "reveal-pending" };
}

function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const { ref, cls } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className={`${cls} ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

function Btn({
  primary,
  children,
  href,
}: {
  primary?: boolean;
  children: ReactNode;
  href: string;
}) {
  const base =
    "inline-flex h-auto items-center gap-2.5 rounded-sm px-5 py-3 text-sm font-bold uppercase tracking-wide transition-all";
  const cls = primary
    ? `${base} bg-primary text-primary-foreground shadow-[var(--shadow-gold)] hover:bg-coral active:translate-y-0.5`
    : `${base} border-2 border-border bg-surface text-cream hover:border-gold hover:text-gold`;
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center justify-center gap-3 font-pixel text-[9px] tracking-[0.2em] text-gold">
      <span className="h-1.5 w-1.5 bg-gold" /> {children} <span className="h-1.5 w-1.5 bg-gold" />
    </p>
  );
}

function Divider() {
  return (
    <div className="mx-auto flex max-w-7xl items-center gap-3 px-6" aria-hidden>
      <span className="h-px flex-1 bg-border" />
      <span className="h-2 w-2 rotate-45 bg-crimson opacity-70" />
      <span className="h-2 w-2 rotate-45 bg-gold" />
      <span className="h-2 w-2 rotate-45 bg-crimson opacity-70" />
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function SectionHead({ k, t, s }: { k: string; t: string; s?: string }) {
  return (
    <Reveal className="mb-14 text-center">
      <Label>{k}</Label>
      <h2 className="mt-5 text-3xl font-bold text-cream lg:text-4xl">{t}</h2>
      {s && (
        <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">{s}</p>
      )}
    </Reveal>
  );
}

export default function LandingPageV2() {
  const [workers, setWorkers] = useState(initialWorkers);
  const summary = summarizeWorkers(workers);
  const [activeSection, setActiveSection] = useState("home");

  useEffect(() => {
    const ids = [
      "home",
      "features",
      "voice-ai",
      "live-task",
      "architecture",
      "our-crew",
      "how-it-works",
      "voice",
      "cta",
    ];
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActiveSection(e.target.id);
        }
      },
      { threshold: 0.25 },
    );
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) io.observe(el);
    });
    return () => io.disconnect();
  }, []);

  return (
    <div className="v2-landing relative z-10 min-h-screen overflow-x-hidden text-foreground">
      {/* ── NAV ─────────────────────────────────────────── */}
      <header className="sticky top-3 z-50 mx-auto mt-4 w-[calc(100%-2rem)] max-w-7xl">
        <div className="pixel-panel flex items-center justify-between gap-4 px-5 py-3">
          <a href="#home" className="flex shrink-0 items-center gap-3">
            <span className="grid h-9 w-9 place-items-center overflow-hidden rounded-sm border-2 border-border bg-deep">
              <PixelCharacter def={CHAR_DEFS.Bob} className="h-8" animate />
            </span>
            <span className="font-pixel text-[10px] text-gold sm:text-[11px]">{brand.name}</span>
          </a>

          <nav className="hidden items-center gap-0.5 lg:flex">
            {nav.map((n) => {
              const id = n.toLowerCase().replace(/ /g, "-");
              const isActive = activeSection === id;
              return (
                <a
                  key={n}
                  href={`#${id}`}
                  className={`whitespace-nowrap rounded-sm border-2 px-3 py-2 text-xs transition-colors ${
                    isActive
                      ? "border-gold text-gold"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-cream"
                  }`}
                >
                  {n}
                </a>
              );
            })}
          </nav>

          <div className="flex shrink-0 items-center gap-3">
            <span className="hidden items-center gap-2 rounded-sm border border-border bg-deep px-3 py-1.5 text-xs text-muted-foreground md:flex">
              <span className="h-2 w-2 animate-pulse bg-mint" /> {summary.total} agents
            </span>
            <Btn primary href="/app">
              Enter App <ArrowRight className="h-3.5 w-3.5" />
            </Btn>
          </div>
        </div>
      </header>

      {/* ── HERO ────────────────────────────────────────── */}
      <section id="home" className="mx-auto max-w-[1440px] px-6 pt-20 lg:pt-28">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.4fr)] lg:gap-10">
          {/* Text col */}
          <div className="relative z-10 animate-reveal">
            <span className="inline-flex items-center gap-2 rounded-sm border border-border bg-panel px-3.5 py-1.5 text-[11px] tracking-widest text-muted-foreground">
              <span className="h-2 w-2 bg-mint" /> {brand.tagline}
            </span>

            <h1 className="mt-8 font-pixel leading-[1.1]">
              <span className="block text-[2.6rem] text-gold glow-gold sm:text-6xl lg:text-7xl">
                KIRANA
              </span>
              <span className="mt-2 block text-[2.6rem] text-cream pixel-shadow sm:text-6xl lg:text-7xl">
                CREW<span className="animate-blink text-gold">_</span>
              </span>
            </h1>

            <p className="mt-7 max-w-sm text-base font-bold leading-relaxed text-cream sm:text-lg">
              {brand.description}
            </p>
            <p className="mt-3 max-w-sm text-sm leading-loose text-muted-foreground">
              Give each AI specialist a role and a task. Speak in your language — your crew picks it
              up.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <Btn primary href="/app">
                <Rocket className="h-4 w-4" /> {brand.ctaEnter}
              </Btn>
              <Btn href="#live-task">
                <Play className="h-4 w-4 fill-current" /> {brand.ctaDemo}
              </Btn>
            </div>

            <div className="mt-10 flex items-center gap-4">
              <div className="flex -space-x-3">
                {agentCrew.slice(0, 4).map((a, i) => (
                  <span key={a.n} className="relative" style={{ zIndex: 4 - i }}>
                    <span className="grid h-11 w-11 place-items-center overflow-hidden rounded-sm border-2 border-panel bg-deep ring-2 ring-panel">
                      <PixelCharacter def={CHAR_DEFS[a.charKey]} className="h-10" animate />
                    </span>
                    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 border-2 border-deep bg-mint" />
                  </span>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">
                {brand.heroAgentLine}
                <br />
                <span className="text-cream">{brand.heroLangs}</span>
              </p>
            </div>
          </div>

          {/* Canvas col */}
          <div className="relative lg:-mr-6">
            <OfficeCanvas onStatus={setWorkers} />
            <div className="pixel-panel absolute bottom-4 right-4 hidden items-center gap-2.5 px-3 py-2 text-xs sm:flex">
              <span className="h-1.5 w-1.5 animate-pulse bg-gold" />
              <span className="text-muted-foreground">DEMO</span>
              <span className="text-cream" data-testid="office-busy">
                {summary.working}/{summary.total} working
              </span>
              <span className="h-3 w-px bg-border" />
              <span className="text-cream">{summary.seated} at desk</span>
            </div>
          </div>
        </div>

        <p className="mt-5 text-center text-[11px] text-muted-foreground opacity-70">
          {brand.liveNote}
        </p>

        {/* Feature cards */}
        <div id="features" className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {features.map((f, i) => {
            const Illus = FEATURE_ILLUS[f.tag] ?? InventoryIllustration;
            return (
              <Reveal key={f.t} delay={i * 80}>
                <div className="pixel-panel group relative flex h-full flex-col p-7 transition-colors hover:border-gold">
                  <span className="absolute right-3 top-3 font-pixel text-[7px] tracking-widest text-crimson opacity-80">
                    {f.tag}
                  </span>
                  <div className="transition-transform duration-300 group-hover:-translate-y-1">
                    <Illus />
                  </div>
                  <h3 className="mt-5 text-center text-sm font-bold text-cream">{f.t}</h3>
                  <p className="mt-2.5 text-center text-xs leading-relaxed text-muted-foreground">
                    {f.d}
                  </p>
                </div>
              </Reveal>
            );
          })}
        </div>

        {/* Stats bar */}
        <Reveal className="mt-6">
          <div className="pixel-panel grid grid-cols-2 gap-y-6 bg-deep px-8 py-6 md:grid-cols-4 md:divide-x md:divide-border">
            {stats.map(({ v, l }, idx) => {
              const Icon = STAT_ICONS[idx] ?? Rocket;
              return (
                <div key={l} className="flex items-center justify-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-sm border border-border bg-surface">
                    <Icon className="h-4 w-4 text-gold" />
                  </span>
                  <div>
                    <div className="font-pixel text-[11px] text-cream">{v}</div>
                    <div className="mt-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {l}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </Reveal>
      </section>

      {/* ── DIVIDER ─────────────────────────────────────── */}
      <div className="py-20">
        <Divider />
      </div>

      {/* ── GNANI VOICE PIPELINE ────────────────────────── */}
      <section id="voice-ai" className="mx-auto max-w-7xl scroll-mt-28 px-6 pb-24">
        <div className="mb-12 text-center">
          <span className="font-pixel text-[9px] tracking-[0.15em] text-gold">
            {gnaniSection.label}
          </span>
          <h2 className="mt-5 text-3xl font-bold text-cream lg:text-4xl">{gnaniSection.heading}</h2>
          <p className="mx-auto mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
            {gnaniSection.sub}
          </p>
        </div>

        {/* Pipeline visualization */}
        <Reveal className="mb-12">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {[
              { label: "SHOPKEEPER SPEAKS", sub: "Kannada · Hindi · Hinglish", color: "#f5c842" },
              { label: "↓", sub: "", color: "#555" },
              { label: "GNANI PRISMA STT", sub: "Speech → Text", color: "#e05c5c" },
              { label: "↓", sub: "", color: "#555" },
              { label: "VOICE ROUTER", sub: "Intent detection", color: "#f5c842" },
              { label: "↓", sub: "", color: "#555" },
              { label: "AI WORKFORCE", sub: "5 specialists", color: "#e05c5c" },
              { label: "↓", sub: "", color: "#555" },
              { label: "GNANI TIMBRE TTS", sub: "Text → Speech", color: "#e05c5c" },
            ].map((step, i) =>
              step.label === "↓" ? (
                <span key={i} className="text-xl" style={{ color: "#555" }}>
                  ↓
                </span>
              ) : (
                <div
                  key={i}
                  className="min-w-[140px] px-4 py-3 text-center"
                  style={{
                    border: `1px solid ${step.color}44`,
                    background: "#1a1510",
                  }}
                >
                  <div
                    className="font-mono text-[10px] font-bold tracking-[0.1em]"
                    style={{ color: step.color }}
                  >
                    {step.label}
                  </div>
                  {step.sub && (
                    <div className="mt-1 font-mono text-[9px]" style={{ color: "#6b6055" }}>
                      {step.sub}
                    </div>
                  )}
                </div>
              ),
            )}
          </div>
        </Reveal>

        {/* Prisma + Timbre model cards */}
        <Reveal>
          <div className="grid gap-6 md:grid-cols-2 mx-auto max-w-3xl">
            <div className="p-6" style={{ border: "1px solid #3a2a20", background: "#1a1510" }}>
              <div
                className="font-mono text-[10px] tracking-[0.1em] mb-3"
                style={{ color: "#e05c5c" }}
              >
                {gnaniSection.prismaLabel}
              </div>
              <div className="font-mono text-base font-bold text-cream mb-2">
                {gnaniSection.prismaTitle}
              </div>
              <p className="font-mono text-xs leading-relaxed" style={{ color: "#7a6a5a" }}>
                {gnaniSection.prismaDesc}
              </p>
              <div
                className="mt-4 p-3"
                style={{ background: "#0f0d0a", border: "1px solid #2a2018" }}
              >
                <div className="font-mono text-[9px] mb-1" style={{ color: "#6b6055" }}>
                  EXAMPLE TRANSCRIPT
                </div>
                <div className="font-mono text-xs" style={{ color: "#f5c842" }}>
                  {gnaniSection.prismaExample}
                </div>
                <div className="font-mono text-[10px] mt-1" style={{ color: "#7a6a5a" }}>
                  {gnaniSection.prismaResult}
                </div>
              </div>
            </div>

            <div className="p-6" style={{ border: "1px solid #3a2a20", background: "#1a1510" }}>
              <div
                className="font-mono text-[10px] tracking-[0.1em] mb-3"
                style={{ color: "#e05c5c" }}
              >
                {gnaniSection.timbreLabel}
              </div>
              <div className="font-mono text-base font-bold text-cream mb-2">
                {gnaniSection.timbreTitle}
              </div>
              <p className="font-mono text-xs leading-relaxed" style={{ color: "#7a6a5a" }}>
                {gnaniSection.timbreDesc}
              </p>
              <div
                className="mt-4 p-3"
                style={{ background: "#0f0d0a", border: "1px solid #2a2018" }}
              >
                <div className="font-mono text-[9px] mb-1" style={{ color: "#6b6055" }}>
                  EXAMPLE RESPONSE
                </div>
                <div className="font-mono text-xs leading-relaxed" style={{ color: "#f5c842" }}>
                  {gnaniSection.timbreExample}
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        <p className="mt-6 text-center font-mono text-[10px]" style={{ color: "#4a3a2a" }}>
          {gnaniSection.evonNote}
        </p>
      </section>

      <TaskWalkthrough />
      <Architecture />

      <div className="pb-20">
        <Divider />
      </div>

      {/* ── AGENTS ──────────────────────────────────────── */}
      <section id="our-crew" className="mx-auto max-w-7xl px-6 pb-24">
        <SectionHead
          k="MEET THE CREW"
          t="Five Specialists. One Smarter Store."
          s="Each agent has a specific role, controlled ERP permissions, and one shared mission."
        />
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          {agentCrew.map((a, i) => {
            const worker = workers.find((w) => w.name.toLowerCase() === a.n.toLowerCase());
            return (
              <Reveal key={a.n} delay={i * 80}>
                <div className="pixel-panel group p-5 transition-colors hover:border-gold">
                  <div className="relative grid h-44 place-items-center rounded-sm border border-border bg-deep">
                    <PixelCharacter def={CHAR_DEFS[a.charKey]} className="h-36" animate />
                    <span className="absolute left-2 top-2 font-pixel text-[7px] text-muted-foreground opacity-60">
                      AGENT {a.seat}
                    </span>
                    <span className="absolute right-2 top-2 rounded-sm border border-border bg-panel px-1.5 py-0.5 text-[9px] text-cream">
                      {worker?.status ?? a.status}
                    </span>
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <span className="font-pixel text-[11px] text-cream">{a.n}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {worker?.seated ? "At desk" : "Away"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-gold">{a.role}</div>
                  <div className="mt-4 flex items-center gap-2 border-t border-dashed border-border pt-3 text-xs text-muted-foreground">
                    <span
                      className={`h-2 w-2 shrink-0 ${worker?.status === "working" ? "bg-mint" : worker?.status === "idle" ? "bg-gold" : "bg-muted-foreground"}`}
                    />
                    {worker?.activity ?? a.status}
                  </div>
                </div>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* ── HOW IT WORKS ────────────────────────────────── */}
      <section id="how-it-works" className="mx-auto max-w-7xl px-6 pb-24">
        <SectionHead
          k="HOW IT WORKS"
          t="From a spoken command to finished work"
          s="The voice-first task journey your shopkeeper experiences every time."
        />
        <div className="grid gap-5 md:grid-cols-4">
          {howItWorksSteps.map((s, i) => (
            <Reveal key={s.t} delay={i * 80}>
              <div className="pixel-panel relative h-full p-7">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-burgundy font-pixel text-sm text-gold">
                    {i + 1}
                  </span>
                  {i < 3 && (
                    <span className="hidden h-px flex-1 border-t border-dashed border-border md:block" />
                  )}
                </div>
                <h3 className="mt-6 font-bold text-cream">{s.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── VOICE BANNER ────────────────────────────────── */}
      <section id="voice" className="mx-auto max-w-7xl px-6 pb-24">
        <Reveal>
          <div className="pixel-panel grid items-center gap-8 border-crimson p-8 md:grid-cols-[auto_1fr_auto] md:p-12">
            <span className="grid h-16 w-16 place-items-center rounded-sm border-2 border-crimson bg-burgundy shadow-[inset_0_-3px_0_var(--deep)]">
              <Mic className="h-7 w-7 text-cream" />
            </span>
            <div>
              <p className="font-pixel text-[9px] tracking-[0.2em] text-crimson">
                {voiceBanner.label}
              </p>
              <h2 className="mt-3 text-2xl font-bold text-cream sm:text-3xl">
                {voiceBanner.heading}
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
                {voiceBanner.sub}
              </p>
            </div>
            <div className="flex h-12 items-end gap-1" aria-hidden>
              {[0.4, 0.8, 0.55, 1, 0.65, 0.9, 0.45].map((h, i) => (
                <span
                  key={i}
                  className="w-1.5 animate-wave bg-crimson"
                  style={{ height: `${h * 100}%`, animationDelay: `${i * 120}ms` }}
                />
              ))}
            </div>
          </div>
        </Reveal>
      </section>

      {/* ── CTA ─────────────────────────────────────────── */}
      <section id="cta" className="mx-auto max-w-3xl px-6 pb-28 pt-4 text-center">
        <Reveal>
          <div className="mb-8 flex justify-center gap-3">
            {ctaCrew.map((a) => (
              <span
                key={a.n}
                className="grid h-16 w-16 place-items-center overflow-hidden rounded-sm border-2 border-border bg-deep"
              >
                <PixelCharacter def={CHAR_DEFS[a.charKey]} className="h-[58px]" animate />
              </span>
            ))}
          </div>
          <h2 className="font-pixel text-2xl leading-relaxed text-gold glow-gold sm:text-[2rem]">
            {brand.ctaBuild}
          </h2>
          <p className="mx-auto mt-5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {brand.ctaSub}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <Btn primary href="/app">
              <Rocket className="h-4 w-4" /> {brand.ctaEnter}
            </Btn>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-auto items-center gap-2.5 rounded-sm border-2 border-border bg-surface px-5 py-3 text-sm font-bold uppercase tracking-wide text-cream transition-all hover:border-gold hover:text-gold"
            >
              <Github className="h-4 w-4" /> Star on GitHub
            </a>
          </div>
        </Reveal>
      </section>

      {/* ── GNANI ATTRIBUTION ───────────────────────────── */}
      <section className="mx-auto max-w-7xl px-6 pb-12">
        <Reveal>
          <div className="flex flex-wrap items-center justify-center gap-6 border border-dashed border-border px-6 py-5 text-center">
            <span className="font-pixel text-[9px] text-gold">{gnaniAttribution.brand}</span>
            <span className="text-xs text-muted-foreground">{gnaniAttribution.models}</span>
            <span className="text-[10px] text-muted-foreground opacity-60">
              {gnaniAttribution.note}
            </span>
          </div>
        </Reveal>
      </section>

      {/* ── FOOTER ──────────────────────────────────────── */}
      <footer className="border-t border-border bg-deep">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-8 text-xs text-muted-foreground">
          <span className="font-pixel text-[9px] text-gold">{brand.name}</span>
          <nav className="flex flex-wrap gap-5">
            {footerNav.map((n) => (
              <a
                key={n}
                href={`#${n.toLowerCase().replace(/ /g, "-")}`}
                className="whitespace-nowrap transition-colors hover:text-cream"
              >
                {n}
              </a>
            ))}
          </nav>
          <span className="opacity-60">&copy; 2026 KiranaCrew</span>
        </div>
      </footer>
    </div>
  );
}
