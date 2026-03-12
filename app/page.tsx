import Link from "next/link";
import { Header } from "@/components/header";
import { Github, Linkedin, Mail, ArrowUpRight, Twitter } from "lucide-react";
import { getAllPosts } from "@/lib/posts";

export default function Home() {
  const posts = getAllPosts().slice(0, 3);

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-6xl px-6 py-16 md:py-20">
        <section className="grid gap-12 lg:grid-cols-[1.3fr_0.7fr]">
          <div>
            <p className="text-[12px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              Engineering Notes
            </p>
            <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-tight text-foreground md:text-5xl">
              Practical writing on distributed systems, databases, and reliability.
            </h1>
            <p className="mt-6 font-serif text-[18px] leading-relaxed text-muted-foreground">
              I explore how modern systems behave under pressure, document design tradeoffs, and
              share field notes from building dependable software.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/blog"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[14px] font-semibold text-accent-foreground shadow-sm transition hover:translate-y-[-1px] hover:shadow-md"
              >
                Read the blog
                <ArrowUpRight className="h-4 w-4" />
              </Link>
              <Link
                href="/about"
                className="inline-flex items-center rounded-full border border-border/60 bg-card/70 px-5 py-2.5 text-[14px] font-semibold text-foreground transition hover:border-accent/40 hover:text-accent"
              >
                About me
              </Link>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-3xl border border-border/60 bg-card/80 p-6 shadow-sm">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
                Focus Areas
              </h2>
              <div className="mt-4 space-y-3 font-serif text-[16px] text-foreground">
                <p>
                  <span className="font-semibold">Consistency models</span> and how they surface in
                  real-world systems.
                </p>
                <p>
                  <span className="font-semibold">Storage engines</span> and the tradeoffs inside
                  modern databases.
                </p>
                <p>
                  <span className="font-semibold">Reliability patterns</span> for resilient
                  services under failure.
                </p>
              </div>
            </div>

            <div className="rounded-3xl border border-border/60 bg-card/80 p-6 shadow-sm">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.25em] text-muted-foreground">
                Connect
              </h2>
              <div className="mt-4 space-y-3">
                <a
                  href="https://x.com/AmrAMubarak/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between text-[14px] text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Twitter className="h-4 w-4" />
                    Twitter / X
                  </span>
                  <ArrowUpRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
                <a
                  href="https://github.com/amrrdev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between text-[14px] text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Github className="h-4 w-4" />
                    GitHub
                  </span>
                  <ArrowUpRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
                <a
                  href="https://linkedin.com/in/amramubarak"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between text-[14px] text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Linkedin className="h-4 w-4" />
                    LinkedIn
                  </span>
                  <ArrowUpRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
                <a
                  href="mailto:amrrdev@gmail.com"
                  className="group flex items-center justify-between text-[14px] text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Mail className="h-4 w-4" />
                    Email
                  </span>
                  <ArrowUpRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-16">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              Latest writing
            </h2>
            <Link href="/blog" className="text-[14px] font-semibold text-accent">
              View all posts
            </Link>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {posts.map((post) => (
              <article key={post.slug} className="group">
                <Link href={`/blog/${post.slug}`} className="block">
                  <div className="h-full rounded-2xl border border-border/60 bg-card/80 p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg">
                    <div className="mb-3 text-[12px] text-muted-foreground">
                      {new Date(post.date).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      | {post.readTime}
                    </div>
                    <h3 className="mb-2 text-[18px] font-semibold leading-snug text-foreground transition-colors group-hover:text-accent">
                      {post.title}
                    </h3>
                    <p className="font-serif text-[14px] leading-relaxed text-muted-foreground">
                      {post.content.substring(0, 120)}...
                    </p>
                  </div>
                </Link>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
