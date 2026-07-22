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

  const featured = filteredPosts.length > 0 ? filteredPosts[0] : null;
  const rest = filteredPosts.length > 1 ? filteredPosts.slice(1) : [];

  return (
    <>
      <div className="mb-10 space-y-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="w-full md:max-w-sm">
            <label
              htmlFor="blog-search"
              className="text-[12px] font-semibold uppercase tracking-[0.2em] text-muted-foreground"
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
                className="h-11 w-full rounded-[4px] border border-border bg-card pl-10 pr-10 font-geist text-[16px] text-foreground transition focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/10"
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
          <div className="font-geist text-[12px] text-muted-foreground">
            Showing {filteredPosts.length} of {posts.length} posts
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setSelectedCategory("all")}
            className={`rounded-full border px-4 py-2 font-geist text-[11px] transition ${
              selectedCategory === "all"
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border bg-transparent text-muted-foreground hover:border-accent/30 hover:bg-accent/10 hover:text-accent"
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
                className={`rounded-full border px-4 py-2 font-geist text-[11px] transition ${
                  isSelected
                    ? "border-accent/30 bg-accent/10 text-accent"
                    : "border-border bg-transparent text-muted-foreground hover:border-accent/30 hover:bg-accent/10 hover:text-accent"
                }`}
              >
                {category} ({count})
              </button>
            );
          })}
        </div>
      </div>

      {filteredPosts.length === 0 ? (
        <div className="rounded-[8px] border border-dashed border-border bg-card/60 p-8 text-center font-geist text-[14px] text-muted-foreground">
          No posts match your search. Try a different keyword or clear the filters.
        </div>
      ) : (
        <div className="space-y-6">
          {featured && (
            <article>
              <Link href={`/blog/${featured.slug}`} className="block">
                <div className="rounded-[8px] border-2 border-accent/20 bg-card p-6 transition-colors hover:bg-accent/[0.02]">
                  <div className="mb-3 flex items-center gap-3">
                    <CategoryBadge category={featured.category} />
                    <span className="rounded-full bg-accent/15 px-3 py-1 text-[11px] font-semibold uppercase text-accent">
                      Latest
                    </span>
                  </div>
                  <h2 className="font-fraunces text-[26px] font-medium leading-snug text-foreground">
                    {featured.title}
                  </h2>
                  <p className="mt-2 font-geist text-[15px] leading-relaxed text-muted-foreground/90">
                    {featured.content.substring(0, 200)}...
                  </p>
                  <div className="mt-3 font-geist text-[12px] text-muted-foreground">
                    {new Date(featured.date).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    &middot; {featured.readTime}
                  </div>
                </div>
              </Link>
            </article>
          )}

          {rest.map((post) => (
            <article key={post.slug}>
              <Link href={`/blog/${post.slug}`} className="block">
                <div className="rounded-[8px] border border-border bg-card p-6 transition-colors hover:bg-accent/[0.02]">
                  <div className="mb-3">
                    <CategoryBadge category={post.category} />
                  </div>
                  <h2 className="font-fraunces text-[20px] font-medium leading-snug text-foreground">
                    {post.title}
                  </h2>
                  <p className="mt-2 font-geist text-[15px] leading-relaxed text-muted-foreground/90">
                    {post.content.substring(0, 200)}...
                  </p>
                  <div className="mt-3 font-geist text-[12px] text-muted-foreground">
                    {new Date(post.date).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                    &middot; {post.readTime}
                  </div>
                </div>
              </Link>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
