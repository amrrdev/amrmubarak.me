import Link from "next/link";
import { Header } from "@/components/header";
import { Github, Linkedin, Mail, ArrowUpRight, Twitter } from "lucide-react";
import { getAllPosts } from "@/lib/posts";

export default function Home() {
  const posts = getAllPosts().slice(0, 3);

  return (
    <>
      <Header />
      <main className="mx-auto max-w-6xl px-6 py-16 md:py-20">
        <section className="grid gap-12 lg:grid-cols-[1.3fr_0.7fr]">
          <div>
            <div className="flex items-center gap-4">
              <div className="h-[10px] w-[10px] rounded-[2px] bg-gradient-to-br from-[#E030EB] to-[#00D4FF]" />
              <p className="text-[12px] font-geist font-semibold uppercase tracking-[0.3em] text-muted-foreground">
                Engineering Notes
              </p>
            </div>
            <h1 className="mt-4 text-[32px] font-fraunces font-medium leading-[1.1] tracking-tight text-foreground md:text-[44px] lg:text-[52px]">
              Practical writing on distributed systems, databases, and reliability.
            </h1>
            <p className="mt-5 font-geist text-[17px] leading-relaxed text-muted-foreground">
              I explore how modern systems behave under pressure, document design tradeoffs, and
              share field notes from building dependable software.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/blog"
                className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-2.5 text-[16px] font-semibold leading-6 text-primary-foreground shadow-[oklch(0.22_0.025_285/0.18)_0px_24px_60px_-30px] transition hover:opacity-90"
              >
                Read the blog
                <ArrowUpRight className="h-4 w-4" />
              </Link>
              <Link
                href="/about"
                className="inline-flex items-center rounded-full border border-border bg-transparent px-5 py-2.5 text-[11px] font-geist text-muted-foreground transition hover:border-accent/30 hover:bg-accent/[0.05]"
              >
                About me
              </Link>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-[8px] border border-border bg-card p-8 shadow-[oklch(0.22_0.025_285/0.08)_0px_1px_3px]">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Focus Areas
              </h2>
              <div className="mt-4 space-y-3 font-geist text-[16px] text-foreground">
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

            <div className="rounded-[8px] border border-border bg-card p-8 shadow-[oklch(0.22_0.025_285/0.08)_0px_1px_3px]">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Connect
              </h2>
              <div className="mt-4 space-y-3">
                <a
                  href="https://x.com/AmrAMubarak/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between font-geist text-[16px] text-foreground transition-colors hover:text-accent"
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
                  className="group flex items-center justify-between font-geist text-[16px] text-foreground transition-colors hover:text-accent"
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
                  className="group flex items-center justify-between font-geist text-[16px] text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Linkedin className="h-4 w-4" />
                    LinkedIn
                  </span>
                  <ArrowUpRight className="h-4 w-4 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
                <a
                  href="mailto:amrrdev@gmail.com"
                  className="group flex items-center justify-between font-geist text-[16px] text-foreground transition-colors hover:text-accent"
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
            <Link href="/blog" className="font-geist text-[12px] text-accent">
              View all posts
            </Link>
          </div>
          <div className="grid gap-6 lg:grid-cols-3">
            {posts.map((post) => (
              <article key={post.slug} className="group">
                <Link href={`/blog/${post.slug}`} className="block">
                  <div className="h-full border border-border p-6 transition-colors duration-200 hover:bg-accent/[0.02]">
                    <div className="mb-3 text-[12px] text-muted-foreground">
                      {new Date(post.date).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}{" "}
                      &middot; {post.readTime}
                    </div>
                    <h3 className="mb-2 font-fraunces text-[22px] font-medium leading-snug text-foreground">
                      {post.title}
                    </h3>
                    <p className="font-geist text-[14px] leading-relaxed text-muted-foreground/85">
                      {post.content.substring(0, 120)}...
                    </p>
                  </div>
                </Link>
              </article>
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
