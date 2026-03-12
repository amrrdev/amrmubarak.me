"use client";

import Link from "next/link";
import { CategoryBadge } from "./category-badge";
import { useState } from "react";
import type { Post } from "@/lib/posts";
import { Search, X } from "lucide-react";

interface BlogListProps {
  posts: Post[];
  categories: string[];
}

export function BlogList({ posts, categories }: BlogListProps) {
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

  return (
    <>
      <div className="mb-10 space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="w-full md:max-w-sm">
            <label
              htmlFor="blog-search"
              className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground"
            >
              Search posts
            </label>
            <div className="relative mt-2">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                id="blog-search"
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
            All Posts ({posts.length})
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

      {filteredPosts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-card/60 p-8 text-center text-[14px] text-muted-foreground">
          No posts match your search. Try a different keyword or clear the filters.
        </div>
      ) : (
        <div className="space-y-6">
          {filteredPosts.map((post) => (
            <article key={post.slug} className="group">
              <Link href={`/blog/${post.slug}`} className="block">
                <div className="rounded-2xl border border-border/60 bg-card/80 p-6 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg">
                  <div className="mb-3 flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
                    <CategoryBadge category={post.category} />
                    <span className="text-border">|</span>
                    <time dateTime={post.date} className="font-medium">
                      {new Date(post.date).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                    <span className="text-border">|</span>
                    <span>{post.readTime}</span>
                  </div>
                  <h2 className="mb-3 text-[20px] font-semibold leading-snug text-foreground transition-colors group-hover:text-accent">
                    {post.title}
                  </h2>
                  <p className="font-serif text-[15px] leading-relaxed text-muted-foreground/90">
                    {post.content.substring(0, 180)}...
                  </p>
                </div>
              </Link>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
