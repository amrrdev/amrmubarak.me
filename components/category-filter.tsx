"use client";

interface CategoryFilterProps {
  categories: string[];
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
}

const categoryColors: Record<string, string> = {
  "Distributed Systems":
    "bg-amber-500/20 hover:bg-amber-500/30 text-amber-700 dark:text-amber-300 border-amber-500/40",
  "Database Internals":
    "bg-teal-500/20 hover:bg-teal-500/30 text-teal-700 dark:text-teal-300 border-teal-500/40",
  "System Design": "bg-sky-500/20 hover:bg-sky-500/30 text-sky-700 dark:text-sky-300 border-sky-500/40",
};

export function CategoryFilter({
  categories,
  selectedCategory,
  onCategoryChange,
}: CategoryFilterProps) {
  return (
    <div className="mb-10 flex flex-wrap gap-2">
      <button
        onClick={() => onCategoryChange("all")}
        className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
          selectedCategory === "all"
            ? "border-accent/50 bg-accent/15 text-accent shadow-sm"
            : "border-border/60 bg-card/70 text-muted-foreground hover:border-accent/40 hover:text-foreground"
        }`}
      >
        All Posts
      </button>
      {categories.map((category) => {
        const colorClass =
          categoryColors[category] ||
          "bg-muted/50 hover:bg-muted text-muted-foreground border-border";
        const isSelected = selectedCategory === category;

        return (
          <button
            key={category}
            onClick={() => onCategoryChange(category)}
            className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
              isSelected
                ? colorClass + " shadow-sm"
                : "border-border/60 bg-card/70 text-muted-foreground hover:border-accent/40 hover:text-foreground"
            }`}
          >
            {category}
          </button>
        );
      })}
    </div>
  );
}
