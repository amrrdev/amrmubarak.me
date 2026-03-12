"use client";

import Link from "next/link";
import { useState } from "react";
import { CategoryBadge } from "@/components/category-badge";
import type { Post } from "@/lib/posts";
import { Search, X } from "lucide-react";

interface ArchiveListProps {
  posts: Post[];
  categories: string[];
}

export function ArchiveList({ posts, categories }: ArchiveListProps) {
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const categoryFiltered =
    selectedCategory === "all" ? posts : posts.filter((post) => post.category === selectedCategory);
  const filteredPosts = categoryFiltered.filter((post) => {
    if (!normalizedQuery) {
      return true;
    }
    const haystack = `${post.title} ${post.category} ${post.content}`.toLowerCase();
    return haystack.includes(normalizedQuery);
  });

  const postsByYear = filteredPosts.reduce(
    (acc, post) => {
      const year = new Date(post.date).getFullYear();
      if (!acc[year]) {
        acc[year] = [];
      }
      acc[year].push(post);
      return acc;
    },
    {} as Record<number, Post[]>
  );

  const years = Object.keys(postsByYear).sort((a, b) => Number(b) - Number(a));

  return (
    <>
      <div className="mb-10 space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="w-full md:max-w-sm">
            <label
              htmlFor="archive-search"
              className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground"
            >
              Search posts
            </label>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="archive-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by title, category, or content"
                className="h-11 w-full rounded-full border border-border/60 bg-card/70 pl-10 pr-10 text-[14px] text-foreground shadow-sm transition focus:border-accent/60 focus:outline-none"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground transition hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
          </div>
          <div className="text-[12px] text-muted-foreground">
            Showing {filteredPosts.length} of {posts.length} posts
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedCategory("all")}
            className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
              selectedCategory === "all"
                ? "border-accent/50 bg-accent/15 text-accent shadow-sm"
                : "border-border/60 bg-card/70 text-muted-foreground hover:border-accent/40 hover:text-foreground"
            }`}
          >
            All ({posts.length})
          </button>
          {categories.map((category) => {
            const count = posts.filter((p) => p.category === category).length;
            const isSelected = selectedCategory === category;

            return (
              <button
                key={category}
                onClick={() => setSelectedCategory(category)}
                className={`rounded-full border px-4 py-2 text-[12px] font-medium transition ${
                  isSelected
                    ? "border-accent/50 bg-accent/15 text-accent shadow-sm"
                    : "border-border/60 bg-card/70 text-muted-foreground hover:border-accent/40 hover:text-foreground"
                }`}
              >
                {category} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {years.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card/60 p-8 text-center text-[14px] text-muted-foreground">
          No posts match your search. Try a different keyword or clear the filters.
        </div>
      ) : (
        <div className="space-y-12">
          {years.map((year) => (
            <div key={year}>
              <h2 className="mb-4 text-[14px] font-semibold uppercase tracking-[0.2em] text-accent">
                {year}
              </h2>
              <div className="space-y-3">
                {postsByYear[Number(year)].map((post) => (
                  <article key={post.slug}>
                    <Link href={`/blog/${post.slug}`} className="group block">
                      <div className="rounded-2xl border border-border/60 bg-card/80 px-5 py-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md">
                        <div className="mb-2 flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
                          <CategoryBadge category={post.category} />
                          <span className="text-border">|</span>
                          <time className="font-medium" dateTime={post.date}>
                            {new Date(post.date).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                          </time>
                          <span className="text-border">|</span>
                          <span>{post.readTime}</span>
                        </div>
                        <h2 className="text-[17px] font-medium text-foreground transition-colors group-hover:text-accent">
                          {post.title}
                        </h2>
                      </div>
                    </Link>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
