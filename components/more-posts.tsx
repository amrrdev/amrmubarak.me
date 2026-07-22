import Link from "next/link";
import { getAllPosts } from "@/lib/posts";

interface MorePostsProps {
  currentSlug: string;
}

export function MorePosts({ currentSlug }: MorePostsProps) {
  const allPosts = getAllPosts();
  const related = allPosts.filter((p) => p.slug !== currentSlug).slice(0, 3);

  if (related.length === 0) return null;

  return (
    <section className="mt-16 border-t border-border/40 pt-10">
      <h2 className="mb-6 text-[12px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
        More posts
      </h2>
      <div className="divide-y divide-border/30">
        {related.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="group flex items-center justify-between py-3.5 transition-colors hover:bg-accent/[0.02] -mx-3 px-3 rounded-[4px]"
          >
            <span className="font-geist text-[15px] text-foreground transition-colors group-hover:text-accent">
              {post.title}
            </span>
            <span className="shrink-0 font-geist text-[12px] text-muted-foreground">
              {new Date(post.date).toLocaleDateString("en-US", {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
