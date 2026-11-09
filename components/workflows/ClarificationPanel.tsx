"use client";
import { useRef, useState } from "react";
import { HelpCircle, Loader2 } from "lucide-react";
import type { WorkflowSummary, WorkflowView } from "@/lib/workflow-contract";
import { canAnswerHere, mergeAnswers, questionsFor, saveAnsweredLink } from "./clarify";
import { clarificationQuestion } from "./reports/helpers";
import { panel, ui } from "./styles";

/**
 * Shows what a run is missing and lets the owner answer it. There is no resume endpoint on the
 * server, so the answer starts a NEW run from the original request (the old run stays as it was, and
 * is marked "answered" in this tab). The result is the same as asking again in chat or by voice.
 */
export function ClarificationPanel({
  view,
  onStart,
  onStarted,
}: {
  view: WorkflowView;
  /** Starts the new run (POST /workflows). Rejects with the server's message. */
  onStart: (intent: Record<string, unknown>) => Promise<WorkflowSummary>;
  /** Called with the new run so the page can open it. */
  onStarted: (run: WorkflowSummary) => void;
}) {
  const questions = questionsFor(view);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const guard = useRef(false); // a double click must not start two runs

  if (!questions.length) return null;
  const answerable = canAnswerHere(view);

  const submit = async () => {
    if (guard.current) return;
    const merged = mergeAnswers(view.intent, questions, answers);
    if (!merged.intent) {
      setError(merged.error ?? "Could not build the request.");
      return;
    }
    guard.current = true;
    setSending(true);
    setError(null);
    try {
      const run = await onStart({ intent: merged.intent });
      if (run.id) saveAnsweredLink(view.id, run.id);
      setDone(run.id);
      onStarted(run);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start the new run.");
      guard.current = false;
    } finally {
      setSending(false);
    }
  };

  if (done)
    return (
      <div style={panel("good")} role="status">
        Thanks. A new run has started with your answer. It is the first one in the run history, and its report opens there when it finishes.
      </div>
    );

  return (
    <section aria-label="Answer to continue" style={{ marginTop: 12 }}>
      <h3 style={{ ...ui.heading, fontSize: 15, fontWeight: 700, margin: "0 0 8px", display: "flex", alignItems: "center", gap: 6 }}>
        <HelpCircle size={15} aria-hidden="true" /> A little more information is needed
      </h3>
      {questions.map((q) => {
        const id = `clar-${view.id}-${q.index}`;
        const picks = [...q.options, ...q.groups.map((g) => g)];
        return (
          <div key={q.index} style={{ marginBottom: 14 }}>
            <p id={`${id}-q`} style={{ margin: "0 0 6px", fontSize: 14, fontWeight: 600 }}>
              {clarificationQuestion(q.clarification)}
            </p>
            {q.mode === "readonly" ? (
              <p style={{ ...ui.muted, margin: 0 }}>
                This one cannot be answered here. Start a new run from the card above, or ask in chat.
              </p>
            ) : (
              <>
                {picks.length > 0 && (
                  <div role="group" aria-labelledby={`${id}-q`} style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
                    {picks.map((choice) => {
                      const isGroup = q.groups.includes(choice) && !q.options.includes(choice);
                      const size = q.groupSizes[choice];
                      return (
                        <button
                          key={choice}
                          type="button"
                          aria-pressed={answers[q.index] === choice}
                          onClick={() => setAnswers((prev) => ({ ...prev, [q.index]: choice }))}
                          style={{ ...ui.btn(answers[q.index] === choice) }}
                        >
                          {isGroup ? `All ${choice}${size ? ` (${size} products)` : ""}` : choice}
                        </button>
                      );
                    })}
                  </div>
                )}
                <label htmlFor={id} style={ui.label}>
                  {picks.length ? "Or type the product name" : "Product name"}
                </label>
                <input
                  id={id}
                  type="text"
                  autoComplete="off"
                  value={answers[q.index] ?? ""}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [q.index]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && void submit()}
                  placeholder="For example: Atta, Rice"
                  style={ui.input}
                />
              </>
            )}
          </div>
        );
      })}
      {error && (
        <p role="alert" style={{ margin: "0 0 8px", fontSize: 13, color: "var(--kirana-destructive)" }}>{error}</p>
      )}
      {answerable && (
        <button type="button" onClick={() => void submit()} disabled={sending} aria-busy={sending || undefined} style={{ ...ui.btn(true), opacity: sending ? 0.7 : 1 }}>
          {sending && <Loader2 size={13} aria-hidden="true" style={{ animation: "wf-spin 1s linear infinite" }} />}
          {sending ? "Starting…" : "Run again with this answer"}
        </button>
      )}
    </section>
  );
}
