import { Header } from "@/components/header";
import { Github, Linkedin, Mail, ArrowUpRight, Twitter } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <div className="grid gap-16 lg:grid-cols-[2fr_1fr]">
          <div>
            <h1 className="mb-8 text-3xl font-bold tracking-tight text-foreground">
              Who am <span className="text-accent">I</span>
            </h1>
            <div className="space-y-5 text-base leading-relaxed text-muted-foreground">
              <p>
                I am a software engineer passionate about distributed systems, databases, and the
                art of building reliable software. I spend my time thinking about consistency
                models, consensus algorithms, and how systems behave under failure.
              </p>
              <p>
                Currently, I'm interested in{" "}
                <span className="text-foreground font-medium">database internals</span> and how
                modern storage engines work. I write about these topics to clarify my own
                understanding and hopefully help others along the way.
              </p>
              <p className="text-accent/80">
                This blog is my space to explore ideas, document learnings, and share thoughts on
                the systems that power our world.
              </p>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-lg border border-border/40 bg-card/50 p-6">
              <h2 className="mb-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">
                Connect
              </h2>
              <div className="space-y-3">
                <a
                  href="https://x.com/AmrAMubarak/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between text-sm text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Twitter className="h-4 w-4" />
                    Twitter / X
                  </span>
                  <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
                <a
                  href="https://github.com/amrrdev"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between text-sm text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Github className="h-4 w-4" />
                    GitHub
                  </span>
                  <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
                <a
                  href="https://linkedin.com/in/amramubarak"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex items-center justify-between text-sm text-foreground transition-colors hover:text-accent"
                >
                  <span className="flex items-center gap-2">
                    <Linkedin className="h-4 w-4" />
                    LinkedIn
                  </span>
                  <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-100" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border border-border/40 bg-card/50 p-6">
              <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-muted-foreground">
                Email
              </h2>
              <a
                href="mailto:amrrdev@gmail.com"
                className="flex items-center gap-2 text-sm text-accent transition-colors hover:text-accent/80"
              >
                <Mail className="h-4 w-4" />
                <span className="break-all">amrrdev@gmail.com</span>
              </a>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
