import Link from "next/link";
import { Header } from "@/components/header";
import { getAllPosts } from "@/lib/posts";

export default async function Archive() {
  const posts = await getAllPosts();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="mb-10 text-2xl font-semibold text-foreground">Archive</h1>

        <div className="space-y-3">
          {posts.map((post) => (
            <article key={post.slug}>
              <Link href={`/blog/${post.slug}`} className="group block">
                <div className="rounded-lg border border-border/50 bg-card px-5 py-4 transition-all duration-200 hover:border-accent/50 hover:shadow-md hover:shadow-accent/5">
                  <div className="mb-1.5 flex items-center gap-3">
                    <time
                      className="text-[13px] font-medium text-muted-foreground"
                      dateTime={post.date}
                    >
                      {new Date(post.date).toLocaleDateString("en-US", {
                        year: "numeric",
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
      </main>
    </div>
  );
}
