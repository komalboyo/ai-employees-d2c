"use client";

import { useState, useRef, useEffect } from "react";
import { useCitation } from "./CitationProvider";

interface Turn {
  role: "user" | "assistant";
  text: string;
  citations?: { table: string; id: string }[];
  violations?: string[];
  tool_calls?: { name: string }[];
  fallback?: boolean;
}

const SUGGESTIONS = [
  "What's my worst RTO courier?",
  "True margin per adset last 7 days?",
  "Are pincode RTO rates trending up?",
  "Show me Rishi's reasoning on the Crimson pause",
];

export function ChatPanel({ merchant_id }: { merchant_id: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [session_id, setSessionId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  async function send(text?: string) {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [...t, { role: "user", text: msg }]);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant_id, session_id, user_message: msg }),
      });
      const data = await res.json();
      if (data.session_id) setSessionId(data.session_id);
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          text: data.assistant_message ?? data.error ?? "(no response)",
          citations: data.citations,
          violations: data.violations,
          tool_calls: data.tool_calls,
          fallback: data.fallback_used,
        },
      ]);
    } catch (e) {
      setTurns((t) => [...t, { role: "assistant", text: String(e) }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel flex flex-col h-[calc(100vh-120px)] sticky top-4">
      <div className="border-b border-soft px-4 py-3">
        <h2 className="text-base font-semibold">Chat with the team</h2>
        <p className="text-xs dim">
          Follow-up surface. Every numeric answer is cited.
        </p>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs dim">Try:</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="block w-full text-left panel-2 px-3 py-2 text-sm hover:bg-[color:var(--border)]"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <ChatBubble key={i} turn={t} />
        ))}
        {busy && <div className="text-xs dim">thinking…</div>}
        <div ref={endRef} />
      </div>
      <div className="border-t border-soft p-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            placeholder="Ask the team…"
            className="flex-1 bg-[color:var(--panel-2)] border border-soft rounded px-3 py-2 text-sm"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="px-3 py-2 text-sm bg-[color:var(--accent)] text-black rounded disabled:opacity-40"
          >
            send
          </button>
        </form>
      </div>
    </section>
  );
}

function ChatBubble({ turn }: { turn: Turn }) {
  const { open } = useCitation();
  const isUser = turn.role === "user";

  // Render text with [cite:table:ids] pills inline.
  const segments = parseCites(turn.text);

  return (
    <div className={`text-sm ${isUser ? "text-right" : ""}`}>
      <div
        className={`inline-block panel-2 px-3 py-2 max-w-[95%] ${isUser ? "bg-[color:var(--border)]" : ""}`}
      >
        {segments.map((s, i) =>
          s.kind === "text" ? (
            <span key={i}>{s.text}</span>
          ) : (
            <button
              key={i}
              onClick={() => open(s.table!, s.ids![0])}
              className="cite-pill mx-1"
              title={`${s.table}:${s.ids!.join(",")}`}
            >
              {s.table}:{s.ids![0].slice(0, 6)}
              {s.ids!.length > 1 && ` +${s.ids!.length - 1}`}
            </button>
          )
        )}
      </div>
      {!isUser && turn.violations && turn.violations.length > 0 && (
        <div className="text-[11px] text-bad mt-1">
          ⚠ {turn.violations.length} citation violation(s)
        </div>
      )}
      {!isUser && turn.tool_calls && turn.tool_calls.length > 0 && (
        <div className="text-[10px] dim mt-1">
          tools: {turn.tool_calls.map((t) => t.name).join(", ")}
          {turn.fallback && " · offline fallback"}
        </div>
      )}
    </div>
  );
}

type Segment = { kind: "text"; text: string } | { kind: "cite"; table: string; ids: string[] };
function parseCites(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /\[cite:([a-z_]+):([0-9a-f\-,\s]+)\]/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if ((m.index ?? 0) > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    const ids = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    out.push({ kind: "cite", table: m[1], ids });
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
