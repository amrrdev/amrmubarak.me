"use client";

import Link from "next/link";
import { Header } from "@/components/header";
import { getAllPosts, getAllCategories } from "@/lib/posts";
import { CategoryBadge } from "@/components/category-badge";
import { useState } from "react";

export default function Archive() {
  const posts = getAllPosts();
  const categories = getAllCategories();
  const [selectedCategory, setSelectedCategory] = useState("all");

  const filteredPosts =
    selectedCategory === "all" ? posts : posts.filter((post) => post.category === selectedCategory);

  // Group posts by year
  const postsByYear = filteredPosts.reduce((acc, post) => {
    const year = new Date(post.date).getFullYear();
    if (!acc[year]) {
      acc[year] = [];
    }
    acc[year].push(post);
    return acc;
  }, {} as Record<number, typeof posts>);

  const years = Object.keys(postsByYear).sort((a, b) => Number(b) - Number(a));

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h1 className="mb-3 text-2xl font-semibold text-foreground">Archive</h1>
          <p className="text-[14px] text-muted-foreground">
            Browse all {posts.length} posts organized by year and category
          </p>
        </div>

        <div className="mb-10 flex flex-wrap gap-2.5">
          <button
            onClick={() => setSelectedCategory("all")}
            className={`rounded-full border px-5 py-2 text-[13px] font-medium transition-all duration-200 ${
              selectedCategory === "all"
                ? "border-accent bg-accent/15 text-accent shadow-sm shadow-accent/20"
                : "border-border/50 bg-card text-muted-foreground hover:border-accent/50 hover:bg-card/80 hover:text-foreground"
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

        <div className="space-y-12">
          {years.map((year) => (
            <div key={year}>
              <h2 className="mb-4 text-[15px] font-semibold text-accent">{year}</h2>
              <div className="space-y-3">
                {postsByYear[Number(year)].map((post) => (
                  <article key={post.slug}>
                    <Link href={`/blog/${post.slug}`} className="group block">
                      <div className="rounded-lg border border-border/50 bg-card px-5 py-4 transition-all duration-200 hover:border-accent/50 hover:shadow-md hover:shadow-accent/5">
                        <div className="mb-2 flex items-center gap-3">
                          <CategoryBadge category={post.category} />
                          <span className="text-[13px] text-muted-foreground/50">·</span>
                          <time
                            className="text-[13px] font-medium text-muted-foreground"
                            dateTime={post.date}
                          >
                            {new Date(post.date).toLocaleDateString("en-US", {
                              month: "short",
                              day: "numeric",
                            })}
                          </time>
                          <span className="text-[13px] text-muted-foreground/50">·</span>
                          <span className="text-[13px] text-muted-foreground">{post.readTime}</span>
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
      </main>
    </div>
  );
}
