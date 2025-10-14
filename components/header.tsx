import Link from "next/link"

export function Header() {
  return (
    <header className="border-b border-border/40 py-6">
      <div className="mx-auto max-w-4xl px-6">
        <nav className="flex items-center justify-between">
          <Link href="/" className="text-base font-medium text-accent transition-colors hover:text-accent/80">
            Home
          </Link>
          <div className="flex items-center gap-8">
            <Link href="/blog" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
              Blog
            </Link>
            <Link href="/archive" className="text-sm text-muted-foreground transition-colors hover:text-foreground">
              Archive
            </Link>
          </div>
        </nav>
      </div>
    </header>
  )
}
