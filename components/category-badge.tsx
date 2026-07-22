interface CategoryBadgeProps {
  category: string;
  variant?: "default" | "large";
}

const categoryColors: Record<string, { bg: string; text: string; border: string }> = {
  "Distributed Systems": {
    bg: "bg-accent/10",
    text: "text-accent",
    border: "border-accent/20",
  },
  "Database Internals": {
    bg: "bg-[#00D4FF]/10",
    text: "text-[#00D4FF]",
    border: "border-[#00D4FF]/20",
  },
  "System Design": {
    bg: "bg-[#E030EB]/10",
    text: "text-[#E030EB]",
    border: "border-[#E030EB]/20",
  },
  "AI Engineering": {
    bg: "bg-accent/10",
    text: "text-accent",
    border: "border-accent/20",
  },
  Uncategorized: {
    bg: "bg-muted/30",
    text: "text-muted-foreground",
    border: "border-border",
  },
};

export function CategoryBadge({ category, variant = "default" }: CategoryBadgeProps) {
  const colors = categoryColors[category] || categoryColors.Uncategorized;
  const sizeClasses = variant === "large" ? "px-3 py-1.5 text-[13px]" : "px-2.5 py-1 text-[11px]";

  return (
    <span
      className={`inline-flex items-center rounded-full border font-geist font-medium ${colors.bg} ${colors.text} ${colors.border} ${sizeClasses}`}
    >
      {category}
    </span>
  );
}
