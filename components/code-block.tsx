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
    const pre = (children as React.ReactElement)?.props?.children as string | undefined;
    const text = typeof pre === "string" ? pre : "";
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative my-7">
      <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
        {lang && (
          <span className="rounded-[4px] bg-accent/10 px-2 py-0.5 font-geist text-[11px] text-accent">
            {lang}
          </span>
        )}
        <button
          onClick={copy}
          className="inline-flex h-7 w-7 items-center justify-center rounded-[4px] bg-code-bg/90 text-code-text/70 transition-colors hover:bg-code-bg hover:text-code-text"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {children}
    </div>
  );
}
