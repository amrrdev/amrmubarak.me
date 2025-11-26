import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-sm py-5">
      <div className="mx-auto max-w-6xl px-6">
        <nav className="flex items-center justify-between">
          <Link
            href="/"
            className="text-[15px] font-semibold text-accent transition-colors hover:text-accent/80"
          >
            Home
          </Link>
          <div className="flex items-center gap-7">
            <Link
              href="/blog"
              className="text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Blog
            </Link>
            <Link
              href="/archive"
              className="text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Archive
            </Link>
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </header>
  );
}
