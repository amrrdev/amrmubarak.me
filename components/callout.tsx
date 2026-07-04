import type { ReactNode } from "react";

interface CalloutProps {
  children: ReactNode;
  variant?: "stat" | "quote";
}

export function Callout({ children, variant = "stat" }: CalloutProps) {
  if (variant === "quote") {
    return (
      <blockquote className="my-8 border-l-2 border-accent/50 pl-5 font-serif text-[18px] italic leading-relaxed text-foreground/80">
        {children}
      </blockquote>
    );
  }

  return (
    <div className="my-8 rounded-2xl border border-accent/20 bg-accent/[0.04] px-6 py-5 shadow-sm">
      <div className="font-serif text-[17px] leading-relaxed text-foreground/90">
        {children}
      </div>
    </div>
  );
}
