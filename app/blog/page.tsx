import { BlogList } from "@/components/blog-list";
import { Header } from "@/components/header";
import { getAllPosts, getAllCategories } from "@/lib/posts";

export default function BlogPage() {
  const posts = getAllPosts();
  const categories = getAllCategories();

  return (
    <>
      <Header />
      <main className="mx-auto max-w-4xl px-6 py-16 md:py-20">
        <div className="mb-12 space-y-4">
          <p className="text-[12px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            The Blog
          </p>
          <h1 className="font-fraunces text-[32px] font-medium leading-tight text-foreground md:text-[48px]">
            Writing on systems that need to stay up.
          </h1>
          <p className="max-w-2xl font-geist text-[17px] leading-relaxed text-muted-foreground">
            Notes on databases, distributed systems, and the engineering habits that keep software
            dependable in production.
          </p>
        </div>
        <BlogList posts={posts} categories={categories} />
      </main>
    </>
  );
}
