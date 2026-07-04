interface CategoryBadgeProps {
  category: string;
  variant?: "default" | "large";
}

const categoryColors: Record<string, { bg: string; text: string; border: string }> = {
  "Distributed Systems": {
    bg: "bg-indigo-500/15",
    text: "text-indigo-700 dark:text-indigo-300",
    border: "border-indigo-500/30",
  },
  "Database Internals": {
    bg: "bg-sky-500/15",
    text: "text-sky-700 dark:text-sky-300",
    border: "border-sky-500/30",
  },
  "System Design": {
    bg: "bg-violet-500/15",
    text: "text-violet-700 dark:text-violet-300",
    border: "border-violet-500/30",
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
