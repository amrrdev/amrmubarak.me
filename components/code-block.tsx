"use client";

import { Copy, Check } from "lucide-react";
import { useState } from "react";

interface CodeBlockProps {
  lang?: string;
  children: React.ReactNode;
}

export function CodeBlock({ lang, children }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    const pre = (children as any)?.props?.children;
    const text = typeof pre === "string" ? pre : "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-7">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
        {lang && (
          <span className="rounded-md bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
            {lang}
          </span>
        )}
        <button
          onClick={copy}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-card/90 text-muted-foreground shadow-sm transition-colors hover:bg-card hover:text-foreground"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {children}
    </div>
  );
}
