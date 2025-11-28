interface CategoryBadgeProps {
  category: string;
  variant?: "default" | "large";
}

const categoryColors: Record<string, { bg: string; text: string; border: string }> = {
  "Distributed Systems": {
    bg: "bg-purple-500/10",
    text: "text-purple-400",
    border: "border-purple-500/30",
  },
  "Database Internals": {
    bg: "bg-blue-500/10",
    text: "text-blue-400",
    border: "border-blue-500/30",
  },
  "System Design": {
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
    border: "border-emerald-500/30",
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
