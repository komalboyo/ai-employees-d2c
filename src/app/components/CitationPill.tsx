"use client";

import { useCitation } from "./CitationProvider";

export function CitationPill({ table, id, label }: { table: string; id: string; label?: string }) {
  const { open } = useCitation();
  const short = id.slice(0, 8);
  return (
    <button className="cite-pill" onClick={() => open(table, id)} title={`${table}:${id}`}>
      {label ?? `${table}:${short}`}
    </button>
  );
}
