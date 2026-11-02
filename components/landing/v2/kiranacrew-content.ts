// ── KiranaCrew content strings ───────────────────────────────────────────────
// Centralised content for the landing page.  Import from here instead of
// scattering strings across components.

export const brand = {
  name: "KIRANACREW",
  tagline: "THE AI WORKFORCE FOR INDIAN KIRANA STORES",
  description:
    "Voice-first autonomous AI workforce for Indian kirana stores. Speak in Kannada, Hindi, or Hinglish.",
  ctaEnter: "ENTER KIRANACREW →",
  ctaDemo: "HEAR KIRANACREW SPEAK",
  ctaBuild: "YOUR CREW AWAITS",
  ctaSub: "Less manual work. Smarter decisions. More time for your customers.",
  heroAgentLine: "Manager · Inventory · Sales · Procurement · Finance",
  heroLangs: "ಕನ್ನಡ | हिंदी | English",
  liveNote: "Voice-first simulation · no live ERP execution",
};

export const nav = ["Home", "Features", "Voice AI", "Our Crew", "How It Works"];

export const features = [
  {
    tag: "INVENTORY",
    t: "Stock Intelligence",
    d: "Real-time shelf tracking across products. Low-stock alerts before you run out — spoken in your language.",
  },
  {
    tag: "PROCUREMENT",
    t: "Smart Ordering",
    d: "Compares supplier prices automatically and drafts purchase orders. You just approve with a PIN.",
  },
  {
    tag: "SALES",
    t: "Sales Intelligence",
    d: "Analyses daily sales trends, identifies fast movers and slow stock. Speaks insights aloud.",
  },
  {
    tag: "VOICE AI",
    t: "Gnani Voice AI",
    d: "Gnani Prisma STT converts speech to text. Gnani Timbre TTS reads results back. Kannada, Hindi, Hinglish.",
  },
];

export const stats = [
  { v: "5 AI", l: "Specialists" },
  { v: "3", l: "Languages" },
  { v: "Gnani", l: "Voice AI" },
  { v: "ERP", l: "Connected" },
];

export const agentCrew = [
  {
    n: "Manager",
    role: "Workforce Coordinator",
    status: "Coordinating",
    charKey: "Alice",
    seat: 1,
  },
  {
    n: "Inventory",
    role: "Stock Intelligence",
    status: "Checking stock",
    charKey: "Bob",
    seat: 2,
  },
  {
    n: "Sales",
    role: "Sales Analysis",
    status: "Analysing sales",
    charKey: "Carol",
    seat: 3,
  },
  {
    n: "Procurement",
    role: "Supplier & Purchasing",
    status: "Comparing suppliers",
    charKey: "Dave",
    seat: 4,
  },
  {
    n: "Finance",
    role: "Financial Intelligence",
    status: "Reviewing P&L",
    charKey: "Alice",
    seat: 5,
  },
];

export const howItWorksSteps = [
  {
    t: "Speak naturally",
    d: "Say what you need in Kannada, Hindi or Hinglish. No English required, no dashboards to open.",
  },
  {
    t: "Crew gets to work",
    d: "Specialists check stock, review recent sales, and compare supplier prices simultaneously.",
  },
  {
    t: "AI coordinates the plan",
    d: "Manager agent consolidates results from all specialists and prepares a set of actions.",
  },
  {
    t: "You approve, they execute",
    d: "Only you can authorise purchase orders. A PIN approval keeps your store in your hands.",
  },
];

export const architectureNodes = [
  {
    title: "Voice Input",
    file: "voiceData.ts / voice-router.mjs",
    text: "Gnani Prisma STT converts Kannada, Hindi and Hinglish speech into accurate structured intent.",
  },
  {
    title: "Agent Workforce",
    file: "workforce.mjs / workflows.mjs",
    text: "Manager agent orchestrates five specialists across a DAG — each with scoped ERP permissions.",
  },
  {
    title: "MCP Governance",
    file: "mcp-governance.mjs",
    text: "Every ERP write is reviewed by a governance layer before execution. Full audit trail kept.",
  },
  {
    title: "Voice Response",
    file: "Gnani Timbre TTS",
    text: "Business results converted to natural Kannada and Hindi audio. Owners hear answers, not text.",
  },
];

export const architectureTechRow = [
  { label: "Gnani Prisma STT" },
  { label: "Gnani Timbre TTS" },
  { label: "Multi-Agent DAG" },
  { label: "ERPNext Live" },
];

export const walkthroughMeta = {
  label: "INSIDE A WORKFLOW",
  heading: "One voice command. Your entire store responds.",
  sub: "A sample journey from shelf check to approved purchase order, with every handoff visible.",
  demoLabel: "KIRANA WORKFLOW DEMO",
  demoSub: "Sample events · no live ERP or AI connected",
};

export const voiceBanner = {
  label: "GNANI VOICE AI",
  heading: "Bolkar Batao. KiranaCrew Sambhal Lega.",
  sub: "Powered by Gnani Prisma STT and Gnani Timbre TTS. Speak in your language, hear answers in your language.",
};

export const gnaniSection = {
  label: "POWERED BY GNANI AI",
  heading: "Your Language. Your Store. Your Voice.",
  sub: "No dashboards. No English-only commands. Just speak naturally — Kannada, Hindi, or Hinglish.",
  evonNote: "Evon v3.3 reasoning model available as self-hosted open weights · Integration planned",
  prismaLabel: "GNANI PRISMA v2.5 — STT",
  prismaTitle: "Speech to Text",
  prismaDesc:
    "Converts spoken Kannada, Hindi and Hinglish into accurate transcripts. Powers every voice interaction in KiranaCrew.",
  prismaExample: '"Haalina stock check maadi."',
  prismaResult: "→ check_stock · products: [milk]",
  timbreLabel: "GNANI TIMBRE v2.5 — TTS",
  timbreTitle: "Text to Speech",
  timbreDesc:
    "Converts business results into natural Kannada and Hindi audio. Owners hear answers instead of reading dashboards.",
  timbreExample: '"Milk: 18 packets left. Reorder at 30. Shall I prepare an order?"',
};

export const gnaniAttribution = {
  brand: "Powered by Gnani AI",
  models: "Prisma v2.5 STT · Timbre v2.5 TTS",
  note: "Evon v3.3 reasoning model available as self-hosted open weights",
};

export const footerNav = ["Home", "Features", "Voice AI", "Our Crew", "How It Works"];
