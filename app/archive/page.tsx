import Link from "next/link";
import { Header } from "@/components/header";
import { getAllPosts } from "@/lib/posts";

export default function Archive() {
  const posts = getAllPosts();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-[1000px] px-6 py-12">
        <h1 className="mb-10 text-2xl font-medium text-foreground">Archive</h1>

        <div className="space-y-6">
          {posts.map((post) => (
            <article key={post.slug}>
              <Link href={`/blog/${post.slug}`} className="group block">
                <div className="mb-1">
                  <time className="text-[13px] text-muted-foreground" dateTime={post.date}>
                    {new Date(post.date).toLocaleDateString("en-US", {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </div>
                <h2 className="text-[17px] font-medium text-foreground transition-colors group-hover:text-accent">
                  {post.title}
                </h2>
              </Link>
            </article>
          ))}
        </div>
      </main>
    </div>
  );
}
