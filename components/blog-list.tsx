"use client";

import Link from "next/link";
import { Post } from "@/lib/posts";
import { CategoryBadge } from "./category-badge";
import { useState } from "react";

interface BlogListProps {
  posts: Post[];
  categories: string[];
}

export function BlogList({ posts, categories }: BlogListProps) {
  const [selectedCategory, setSelectedCategory] = useState("all");

  const filteredPosts =
    selectedCategory === "all" ? posts : posts.filter((post) => post.category === selectedCategory);

  return (
    <>
      <div className="mb-10 flex flex-wrap gap-2.5">
        <button
          onClick={() => setSelectedCategory("all")}
          className={`rounded-full border px-5 py-2 text-[13px] font-medium transition-all duration-200 ${
            selectedCategory === "all"
              ? "border-accent bg-accent/15 text-accent shadow-sm shadow-accent/20"
              : "border-border/50 bg-card text-muted-foreground hover:border-accent/50 hover:bg-card/80 hover:text-foreground"
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
              className={`rounded-full border px-5 py-2 text-[13px] font-medium transition-all duration-200 ${
                isSelected
                  ? "border-accent bg-accent/15 text-accent shadow-sm shadow-accent/20"
                  : "border-border/50 bg-card text-muted-foreground hover:border-accent/50 hover:bg-card/80 hover:text-foreground"
              }`}
            >
              {category} ({count})
            </button>
          );
        })}
      </div>

      <div className="space-y-6">
        {filteredPosts.map((post) => (
          <article key={post.slug} className="group">
            <Link href={`/blog/${post.slug}`} className="block">
              <div className="rounded-lg border border-border/50 bg-card p-6 transition-all duration-200 hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5">
                <div className="mb-3 flex items-center gap-3 text-[13px] text-muted-foreground">
                  <CategoryBadge category={post.category} />
                  <span className="text-border">·</span>
                  <time dateTime={post.date} className="font-medium">
                    {new Date(post.date).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                  <span className="text-border">·</span>
                  <span>{post.readTime}</span>
                </div>
                <h2 className="mb-3 text-[19px] font-semibold leading-snug text-foreground transition-colors group-hover:text-accent">
                  {post.title}
                </h2>
                <p className="text-[15px] leading-relaxed text-muted-foreground/90">
                  {post.content.substring(0, 180)}...
                </p>
              </div>
            </Link>
          </article>
        ))}
      </div>
    </>
  );
}
