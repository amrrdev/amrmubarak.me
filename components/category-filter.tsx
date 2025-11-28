"use client";

import { useState } from "react";

interface CategoryFilterProps {
  categories: string[];
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
}

const categoryColors: Record<string, string> = {
  "Distributed Systems":
    "bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 border-purple-500/40",
  "Database Internals": "bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 border-blue-500/40",
  "System Design":
    "bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border-emerald-500/40",
};

export function CategoryFilter({
  categories,
  selectedCategory,
  onCategoryChange,
}: CategoryFilterProps) {
  return (
    <div className="mb-10 flex flex-wrap gap-2.5">
      <button
        onClick={() => onCategoryChange("all")}
        className={`rounded-full border px-5 py-2 text-[13px] font-medium transition-all duration-200 ${
          selectedCategory === "all"
            ? "border-accent bg-accent/15 text-accent shadow-sm shadow-accent/20"
            : "border-border/50 bg-card text-muted-foreground hover:border-accent/50 hover:bg-card/80 hover:text-foreground"
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
            className={`rounded-full border px-5 py-2 text-[13px] font-medium transition-all duration-200 ${
              isSelected
                ? colorClass + " shadow-sm"
                : "border-border/50 bg-card text-muted-foreground hover:border-accent/50 hover:bg-card/80 hover:text-foreground"
            }`}
          >
            {category}
          </button>
        );
      })}
    </div>
  );
}
