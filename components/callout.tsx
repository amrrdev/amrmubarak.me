import type { ReactNode } from "react";

interface CalloutProps {
  children: ReactNode;
  variant?: "stat" | "quote";
}

export function Callout({ children, variant = "stat" }: CalloutProps) {
  if (variant === "quote") {
    return (
      <blockquote className="my-10 border-l-[3px] border-accent/50 bg-accent/[0.02] pl-6 py-4 font-geist text-[16px] italic leading-[1.7] text-foreground/75">
        {children}
      </blockquote>
    );
  }

  return (
    <div className="my-8 rounded-[8px] border-l-4 border-accent bg-accent/[0.03] px-6 py-5">
      <div className="font-geist text-[16px] leading-relaxed text-foreground/90">
        {children}
      </div>
    </div>
  );
}
