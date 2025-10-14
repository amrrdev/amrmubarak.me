import Link from "next/link";
import { getAllPosts } from "@/lib/posts";

export function BlogList() {
  const posts = getAllPosts();

  return (
    <div className="space-y-12">
      {posts.map((post) => (
        <article key={post.slug} className="group">
          <Link href={`/blog/${post.slug}`} className="block">
            <div className="mb-3 flex items-center gap-3 text-[13px] text-muted-foreground">
              <time dateTime={post.date}>
                {new Date(post.date).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </time>
              <span>·</span>
              <span>{post.readTime}</span>
            </div>
            <h2 className="mb-2 text-[17px] font-medium leading-snug text-foreground transition-colors group-hover:text-accent">
              {post.title}
            </h2>
            <p className="text-[15px] leading-relaxed text-muted-foreground">
              {post.content.substring(0, 150)}...
            </p>
          </Link>
        </article>
      ))}
    </div>
  );
}
