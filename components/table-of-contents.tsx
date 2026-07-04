"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface TocItem {
  id: string;
  text: string;
  level: number;
}

export function TableOfContents() {
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState("");

  useEffect(() => {
    const headings = document.querySelectorAll("h2, h3");
    const tocItems: TocItem[] = [];

    headings.forEach((h) => {
      const rawId = h.textContent || "";
      const id = rawId
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
      h.id = id;
      tocItems.push({ id, text: rawId, level: h.tagName === "H2" ? 2 : 3 });
    });

    setItems(tocItems);

    if (tocItems.length < 3) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveId(entry.target.id);
          }
        });
      },
      { rootMargin: "-80px 0px -75% 0px" }
    );

    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, []);

  if (items.length < 3) return null;

  return (
    <aside className="sticky top-24 w-full">
      <h4 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        On this page
      </h4>
      <nav className="max-h-[calc(100vh-10rem)] overflow-y-auto overscroll-contain space-y-0.5 border-l border-border/40 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
        {items.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className={cn(
              "block border-l-2 py-1.5 pl-4 text-[13px] transition-all",
              item.level === 3 ? "pl-8" : "",
              activeId === item.id
                ? "border-accent font-medium text-accent"
                : "border-transparent text-muted-foreground hover:border-accent/40 hover:text-foreground"
            )}
          >
            {item.text}
          </a>
        ))}
      </nav>
    </aside>
  );
}
