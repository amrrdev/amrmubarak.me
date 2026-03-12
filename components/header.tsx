import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            className="text-[15px] font-semibold uppercase tracking-[0.2em] text-foreground transition-colors hover:text-accent"
          >
            Amr Mubarak
          </Link>
          <span className="hidden text-xs uppercase tracking-[0.3em] text-muted-foreground lg:inline">
            Thoughts on Engineering
          </span>
        </div>
        <nav className="flex flex-wrap items-center gap-4 text-[14px] font-medium text-muted-foreground">
          <Link href="/blog" className="transition-colors hover:text-foreground">
            Blog
          </Link>
          <Link href="/archive" className="transition-colors hover:text-foreground">
            Archive
          </Link>
          <Link href="/about" className="transition-colors hover:text-foreground">
            About
          </Link>
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
