import { BlogList } from "@/components/blog-list";
import { Header } from "@/components/header";
import { getAllPosts, getAllCategories } from "@/lib/posts";

export default function BlogPage() {
  const posts = getAllPosts();
  const categories = getAllCategories();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-4xl px-6 py-16 md:py-20">
        <div className="mb-12 space-y-4">
          <p className="text-[12px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            The Blog
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground md:text-5xl">
            Writing on systems that need to stay up.
          </h1>
          <p className="max-w-2xl font-serif text-[17px] leading-relaxed text-muted-foreground">
            Notes on databases, distributed systems, and the engineering habits that keep software
            dependable in production.
          </p>
        </div>
        <BlogList posts={posts} categories={categories} />
      </main>
    </div>
  );
}
