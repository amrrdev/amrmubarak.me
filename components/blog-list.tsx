import Link from "next/link";
import { getAllPosts } from "@/lib/posts";

export async function BlogList() {
  const posts = await getAllPosts();

  return (
    <div className="space-y-6">
      {posts.map((post) => (
        <article key={post.slug} className="group">
          <Link href={`/blog/${post.slug}`} className="block">
            <div className="rounded-lg border border-border/50 bg-card p-6 transition-all duration-200 hover:border-accent/50 hover:shadow-lg hover:shadow-accent/5">
              <div className="mb-3 flex items-center gap-3 text-[13px] text-muted-foreground">
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
  );
}
