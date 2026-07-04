import Link from "next/link";
import type { Metadata } from "next";
import { Header } from "@/components/header";
import { notFound } from "next/navigation";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getAllSlugs, getPostBySlug } from "@/lib/posts";
import { CategoryBadge } from "@/components/category-badge";
import { AuthorByline } from "@/components/author-byline";
import { ReadingProgress } from "@/components/reading-progress";
import { TableOfContents } from "@/components/table-of-contents";
import { ShareButtons } from "@/components/share-buttons";
import { MorePosts } from "@/components/more-posts";
import { CodeBlock } from "@/components/code-block";
import "highlight.js/styles/github-dark.css";

export function generateStaticParams() {
  const slugs = getAllSlugs();
  return slugs.map((slug) => ({
    slug,
  }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) return {};

  return {
    title: post.title,
    description: post.content.substring(0, 160),
    openGraph: {
      title: post.title,
      description: post.content.substring(0, 160),
      type: "article",
      publishedTime: post.date,
      tags: [post.category],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.content.substring(0, 160),
    },
  };
}

export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPostBySlug(slug);

  if (!post) {
    notFound();
  }

  const postUrl = `https://amrmubarak.com/blog/${slug}`;

  return (
    <>
      <ReadingProgress />
      <Header />
      <main className="px-6 py-16 md:py-20">
        <div className="mx-auto max-w-6xl lg:grid lg:grid-cols-[minmax(0,1fr)_220px] lg:gap-12 xl:gap-16">
          <div className="min-w-0">
            <Link
              href="/blog"
              className="mb-12 inline-flex items-center text-[12px] font-semibold uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-foreground"
            >
              &larr; Back to blog
            </Link>

            <article>
              <header className="mb-10 space-y-6">
                <div className="flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground">
                  <CategoryBadge category={post.category} variant="large" />
                </div>
                <h1 className="text-balance text-[32px] font-semibold leading-tight tracking-tight text-foreground md:text-[40px]">
                  {post.title}
                </h1>
                <AuthorByline date={post.date} readTime={post.readTime} />
              </header>

              <div className="prose-custom text-[17px] leading-relaxed text-foreground/92">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeHighlight]}
              components={
                {
                  h2: ({ children }: { children: React.ReactNode }) => (
                    <h2 className="mb-4 mt-12 scroll-mt-24 text-[24px] font-semibold leading-tight text-foreground first:mt-0">
                      {children}
                    </h2>
                  ),
                  h3: ({ children }: { children: React.ReactNode }) => (
                    <h3 className="mb-3 mt-10 scroll-mt-24 text-[20px] font-semibold leading-tight text-foreground">
                      {children}
                    </h3>
                  ),
                  p: ({ children }: { children: React.ReactNode }) => (
                    <p className="mb-6 font-serif text-[17px] leading-[1.75] text-foreground/92">
                      {children}
                    </p>
                  ),
                  ul: ({ children }: { children: React.ReactNode }) => (
                    <ul className="my-6 space-y-2 pl-5 font-serif text-[17px] leading-relaxed text-foreground/92">
                      {children}
                    </ul>
                  ),
                  ol: ({ children }: { children: React.ReactNode }) => (
                    <ol className="my-6 space-y-2 pl-5 font-serif text-[17px] leading-relaxed text-foreground/92 list-decimal">
                      {children}
                    </ol>
                  ),
                  li: ({ children }: { children: React.ReactNode }) => (
                    <li className="relative text-[17px] leading-relaxed text-foreground/92">
                      {children}
                    </li>
                  ),
                  code: ({ inline, children, className, ...props }: any) => {
                    if (inline) {
                      return (
                        <code
                          className="rounded-md bg-muted/60 px-1.5 py-0.5 text-[13.5px] font-mono text-foreground border border-border/40"
                          style={{
                            fontFamily:
                              "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
                          }}
                        >
                          {children}
                        </code>
                      );
                    }
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
                  pre: ({ children, className }: { children: React.ReactNode; className?: string }) => {
                    const lang = className?.replace("language-", "") || "";
                    return (
                      <CodeBlock lang={lang}>
                        <pre
                          className="code-block overflow-x-auto rounded-2xl border p-5 text-[14px] leading-[1.7] shadow-sm"
                          style={{
                            fontFamily:
                              "'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace",
                          }}
                        >
                          {children}
                        </pre>
                      </CodeBlock>
                    );
                  },
                  a: ({ href, children }: { href?: string; children: React.ReactNode }) => (
                    <a
                      href={href}
                      className="text-accent underline decoration-accent/40 underline-offset-4 transition-colors hover:decoration-accent"
                      target={href?.startsWith("http") ? "_blank" : undefined}
                      rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
                    >
                      {children}
                    </a>
                  ),
                  strong: ({ children }: { children: React.ReactNode }) => (
                    <strong className="font-semibold text-foreground">{children}</strong>
                  ),
                  em: ({ children }: { children: React.ReactNode }) => (
                    <em className="italic text-foreground/90">{children}</em>
                  ),
                  blockquote: ({ children }: { children: React.ReactNode }) => (
                    <blockquote className="my-8 border-l-2 border-accent/40 pl-5 font-serif text-[18px] italic leading-relaxed text-foreground/75">
                      {children}
                    </blockquote>
                  ),
                  hr: () => <hr className="my-8 border-t border-border/50" />,
                  img: ({ src, alt }: { src?: string; alt?: string }) => (
                    <img
                      src={src || "/placeholder.svg"}
                      alt={alt || ""}
                      loading="lazy"
                      decoding="async"
                      className="my-8 w-full rounded-2xl border border-border/40 bg-background shadow-sm"
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

          <div className="mt-12 flex items-center justify-between border-t border-border/40 pt-6">
            <ShareButtons url={postUrl} title={post.title} />
            <Link
              href="/blog"
              className="text-[12px] font-semibold uppercase tracking-[0.2em] text-muted-foreground transition-colors hover:text-foreground"
            >
              &larr; Back to blog
            </Link>
          </div>

          <MorePosts currentSlug={slug} />
        </article>
          </div>
          <aside className="hidden lg:block">
            <TableOfContents />
          </aside>
        </div>
      </main>
    </>
  );
}
