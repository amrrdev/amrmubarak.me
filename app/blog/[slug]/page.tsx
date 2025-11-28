import Link from "next/link";
import { Header } from "@/components/header";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getAllSlugs, getPostBySlug } from "@/lib/posts";
import { CategoryBadge } from "@/components/category-badge";
import "highlight.js/styles/github-dark.css";

export function generateStaticParams() {
  const slugs = getAllSlugs();
  return slugs.map((slug) => ({
    slug,
  }));
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <Link
          href="/"
          className="mb-12 inline-flex items-center text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          ← Back
        </Link>

        <article>
          <header className="mb-12">
            <div className="mb-4 flex items-center gap-3 text-[13px]">
              <CategoryBadge category={post.category} variant="large" />
              <span className="text-muted-foreground">·</span>
              <time dateTime={post.date} className="text-muted-foreground">
                {new Date(post.date).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </time>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">{post.readTime}</span>
            </div>
            <h1 className="text-balance text-[28px] font-medium leading-tight tracking-tight text-foreground md:text-[32px]">
              {post.title}
            </h1>
          </header>

          <div className="prose-custom">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={
                {
                  h2: ({ children }: { children: React.ReactNode }) => (
                    <h2 className="mb-4 mt-12 text-[20px] font-medium leading-tight text-foreground first:mt-0">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }: { children: React.ReactNode }) => (
                    <h3 className="mb-3 mt-10 text-[17px] font-medium leading-tight text-foreground">
                      {children}
                    </h3>
                  ),
                  p: ({ children }: { children: React.ReactNode }) => (
                    <p className="mb-5 text-[15px] leading-relaxed text-foreground/85">
                      {children}
                    </p>
                  ),
                  ul: ({ children }: { children: React.ReactNode }) => (
                    <ul className="my-6 space-y-2 pl-5">{children}</ul>
                  ),
                  ol: ({ children }: { children: React.ReactNode }) => (
                    <ol className="my-6 space-y-2 pl-5 list-decimal">{children}</ol>
                  ),
                  li: ({ children }: { children: React.ReactNode }) => (
                    <li className="relative text-[15px] leading-relaxed text-foreground/85">
                      {children}
                    </li>
                  ),
                  code: ({ inline, children, className, ...props }: any) => {
                    if (inline) {
                      return (
                        <code
                          className="rounded bg-muted px-1.5 py-0.5 text-[13.5px] font-mono text-accent border border-border/40"
                          style={{
                            fontFamily:
                              "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
                          }}
                        >
                          {children}
                        </code>
                      );
                    }
                    // For code blocks, let rehype-highlight handle the styling
                    return (
                      <code
                        className={className}
                        style={{
                          fontFamily:
                            "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
                        }}
                        {...props}
                      >
                        {children}
                      </code>
                    );
                  },
                  pre: ({ children }: { children: React.ReactNode }) => (
                    <pre
                      className="my-6 overflow-x-auto rounded-lg border border-border/40 bg-[#0d1117] p-4 text-[14px] leading-[1.7] shadow-sm"
                      style={{
                        fontFamily:
                          "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
                      }}
                    >
                      {children}
                    </pre>
                  ),
                  a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
                    <a
                      href={href}
                      className="text-accent underline decoration-accent/30 underline-offset-2 transition-colors hover:decoration-accent"
                      target={href?.startsWith("http") ? "_blank" : undefined}
                      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
                    >
                      {children}
                    </a>
                  ),
                  strong: ({ children }: { children: React.ReactNode }) => (
                    <strong className="font-medium text-foreground">{children}</strong>
                  ),
                  em: ({ children }: { children: React.ReactNode }) => (
                    <em className="italic text-foreground/90">{children}</em>
                  ),
                  blockquote: ({ children }: { children: React.ReactNode }) => (
                    <blockquote className="my-6 border-l-2 border-accent/30 pl-4 italic text-foreground/75">
                      {children}
                    </blockquote>
                  ),
                  hr: () => <hr className="my-8 border-t border-border/50" />,
                  img: ({ src, alt }: { src?: string; alt?: string }) => (
                    <img
                      src={src || "/placeholder.svg"}
                      alt={alt || ""}
                      className="my-6 rounded-md"
                    />
                  ),
                  table: ({ children }: { children: React.ReactNode }) => (
                    <div className="my-6 overflow-x-auto">
                      <table className="w-full border-collapse text-[14px]">{children}</table>
                    </div>
                  ),
                  thead: ({ children }: { children: React.ReactNode }) => (
                    <thead className="border-b border-border/50">{children}</thead>
                  ),
                  tbody: ({ children }: { children: React.ReactNode }) => <tbody>{children}</tbody>,
                  tr: ({ children }: { children: React.ReactNode }) => (
                    <tr className="border-b border-border/30">{children}</tr>
                  ),
                  th: ({ children }: { children: React.ReactNode }) => (
                    <th className="px-4 py-2 text-left font-medium text-foreground">{children}</th>
                  ),
                  td: ({ children }: { children: React.ReactNode }) => (
                    <td className="px-4 py-2 text-foreground/85">{children}</td>
                  ),
                } as Components
              }
            >
              {post.content}
            </ReactMarkdown>
          </div>
        </article>
      </main>
    </div>
  );
}
