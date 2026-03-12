interface CategoryBadgeProps {
  category: string;
  variant?: "default" | "large";
}

const categoryColors: Record<string, { bg: string; text: string; border: string }> = {
  "Distributed Systems": {
    bg: "bg-amber-500/15",
    text: "text-amber-700 dark:text-amber-300",
    border: "border-amber-500/30",
  },
  "Database Internals": {
    bg: "bg-teal-500/15",
    text: "text-teal-700 dark:text-teal-300",
    border: "border-teal-500/30",
  },
  "System Design": {
    bg: "bg-sky-500/15",
    text: "text-sky-700 dark:text-sky-300",
    border: "border-sky-500/30",
  },
  "AI Engineering": {
    bg: "bg-rose-500/15",
    text: "text-rose-700 dark:text-rose-300",
    border: "border-rose-500/30",
  },
  Uncategorized: {
    bg: "bg-muted/50",
    text: "text-muted-foreground",
    border: "border-border",
  },
};

export function CategoryBadge({ category, variant = "default" }: CategoryBadgeProps) {
  const colors = categoryColors[category] || categoryColors.Uncategorized;
  const sizeClasses = variant === "large" ? "px-3 py-1.5 text-[13px]" : "px-2.5 py-1 text-[11px]";

  return (
    <span
      className={`inline-flex items-center rounded-full border font-medium ${colors.bg} ${colors.text} ${colors.border} ${sizeClasses}`}
    >
      {category}
    </span>
  );
}
