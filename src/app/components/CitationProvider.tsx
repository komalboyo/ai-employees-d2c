"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

interface CitationCtx {
  open: (table: string, id: string) => void;
}

const Ctx = createContext<CitationCtx | null>(null);

export function useCitation() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCitation outside provider");
  return c;
}

export function CitationProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; table?: string; id?: string; data?: any; loading?: boolean }>({ open: false });

  async function open(table: string, id: string) {
    setState({ open: true, table, id, loading: true });
    const res = await fetch(`/api/citation?table=${encodeURIComponent(table)}&id=${encodeURIComponent(id)}`);
    const data = await res.json();
    setState({ open: true, table, id, data, loading: false });
  }

  function close() {
    setState({ open: false });
  }

  return (
    <Ctx.Provider value={{ open }}>
      {children}
      {state.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={close}>
          <div
            className="panel max-w-3xl w-full max-h-[80vh] overflow-auto p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-3">
              <div>
                <div className="text-xs uppercase tracking-wide dim">Citation Inspector</div>
                <div className="font-mono text-sm">
                  {state.table}:{state.id}
                </div>
              </div>
              <button className="dim hover:text-white text-sm" onClick={close}>
                close ✕
              </button>
            </div>
            {state.loading ? (
              <div className="dim">loading…</div>
            ) : state.data?.error ? (
              <div className="text-bad">Error: {state.data.error}</div>
            ) : (
              <div className="space-y-4">
                <div>
                  <div className="text-xs uppercase tracking-wide dim mb-1">normalized row</div>
                  <pre className="panel-2 p-3 text-xs overflow-auto">
                    {JSON.stringify(state.data?.row, null, 2)}
                  </pre>
                </div>
                {state.data?.raw_payload && (
                  <div>
                    <div className="text-xs uppercase tracking-wide dim mb-1">
                      raw payload (source: {state.data.raw_payload.source} · resource:{" "}
                      {state.data.raw_payload.resource} · hash:{" "}
                      <span className="font-mono">
                        {state.data.raw_payload.content_hash?.slice(0, 12)}…
                      </span>
                      )
                    </div>
                    <pre className="panel-2 p-3 text-xs overflow-auto max-h-[40vh]">
                      {JSON.stringify(state.data.raw_payload.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
