import type { CSSProperties } from "react";
import type { Tone } from "@/lib/workflow-contract";

/** The page's existing dark-theme tokens (app/globals.css), gathered once. */
export const TONE_COLOR: Record<Tone, string> = {
  good: "var(--kirana-success)",
  warn: "var(--kirana-primary)",
  bad: "var(--kirana-destructive)",
  active: "var(--kirana-primary)",
  neutral: "var(--kirana-muted-foreground)",
};

export const ui = {
  card: {
    background: "var(--kirana-card)",
    border: "1px solid var(--kirana-border)",
    borderRadius: 14,
    padding: 20,
    marginBottom: 16,
  } as CSSProperties,
  heading: {
    fontFamily: "var(--font-display,system-ui)",
    color: "var(--kirana-foreground)",
    margin: 0,
  } as CSSProperties,
  muted: { fontSize: 12, color: "var(--kirana-muted-foreground)" } as CSSProperties,
  pill: (color: string): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 700,
    background: `color-mix(in oklab,${color} 15%,transparent)`,
    color,
  }),
  btn: (primary?: boolean): CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "8px 14px",
    borderRadius: 9,
    border: primary ? "none" : "1px solid var(--kirana-border)",
    background: primary ? "var(--kirana-primary)" : "var(--kirana-card)",
    color: primary ? "var(--kirana-primary-foreground)" : "var(--kirana-foreground)",
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  }),
  input: {
    display: "block",
    width: "100%",
    padding: "7px 10px",
    borderRadius: 7,
    border: "1px solid var(--kirana-border)",
    background: "var(--kirana-accent)",
    color: "var(--kirana-foreground)",
    fontSize: 13,
    boxSizing: "border-box",
  } as CSSProperties,
  label: {
    display: "block",
    fontSize: 12,
    fontWeight: 600,
    color: "var(--kirana-foreground)",
    margin: "0 0 4px",
  } as CSSProperties,
};

/** A tinted panel in the colour of a tone (for notices and notes). */
export const panel = (tone: Tone): CSSProperties => ({
  display: "flex",
  gap: 10,
  alignItems: "flex-start",
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid color-mix(in oklab,${TONE_COLOR[tone]} 35%,transparent)`,
  background: `color-mix(in oklab,${TONE_COLOR[tone]} 8%,var(--kirana-card))`,
  fontSize: 13,
  lineHeight: 1.45,
  color: "var(--kirana-foreground)",
  marginBottom: 8,
});
