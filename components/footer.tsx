import Link from "next/link";
import { Github, Linkedin, Twitter, Rss } from "lucide-react";

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-background/50">
      <div className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2 lg:col-span-1">
            <Link
              href="/"
              className="font-fraunces text-[16px] text-foreground"
            >
              Amr Mubarak
            </Link>
            <p className="mt-3 max-w-xs font-geist text-[13px] leading-relaxed text-muted-foreground">
              Thoughts on distributed systems, databases, and software engineering.
            </p>
          </div>
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Pages
            </h3>
            <ul className="mt-4 space-y-2.5">
              <li>
                <Link href="/blog" className="font-geist text-[13px] text-muted-foreground transition-colors hover:text-foreground">
                  Blog
                </Link>
              </li>
              <li>
                <Link href="/archive" className="font-geist text-[13px] text-muted-foreground transition-colors hover:text-foreground">
                  Archive
                </Link>
              </li>
              <li>
                <Link href="/about" className="font-geist text-[13px] text-muted-foreground transition-colors hover:text-foreground">
                  About
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Connect
            </h3>
            <ul className="mt-4 space-y-2.5">
              <li>
                <a
                  href="https://x.com/AmrAMubarak"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 font-geist text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Twitter className="h-3.5 w-3.5" />
                  Twitter / X
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/amrrdev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 font-geist text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Github className="h-3.5 w-3.5" />
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://linkedin.com/in/amramubarak"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 font-geist text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Linkedin className="h-3.5 w-3.5" />
                  LinkedIn
                </a>
              </li>
            </ul>
          </div>
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                Feeds
            </h3>
            <ul className="mt-4 space-y-2.5">
              <li>
                <a
                  href="/rss.xml"
                  className="inline-flex items-center gap-2 font-geist text-[13px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Rss className="h-3.5 w-3.5" />
                  RSS Feed
                </a>
              </li>
            </ul>
          </div>
        </div>
        <div className="mt-12 border-t border-border/40 pt-6 text-center text-[12px] text-muted-foreground">
          &copy; {year} Amr Mubarak. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
