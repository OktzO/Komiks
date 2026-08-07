'use client';
import { useState } from 'react';

export function Synopsis({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-border-default rounded-xl bg-card p-4">
      <p className={`text-secondary text-sm leading-relaxed whitespace-pre-line ${expanded ? '' : 'line-clamp-3'}`}>
        {text}
      </p>
      {text.length > 150 && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mt-2 text-xs text-accent hover:underline"
        >
          {expanded ? '...Sembunyikan' : '...Lainnya'}
        </button>
      )}
    </div>
  );
}
