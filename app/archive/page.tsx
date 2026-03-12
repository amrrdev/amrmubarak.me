import { Header } from "@/components/header";
import { ArchiveList } from "@/components/archive-list";
import { getAllCategories, getAllPosts } from "@/lib/posts";

export default function Archive() {
  const posts = getAllPosts();
  const categories = getAllCategories();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-4xl px-6 py-16 md:py-20">
        <div className="mb-10 space-y-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            Archive
          </p>
          <h1 className="text-3xl font-semibold text-foreground md:text-4xl">
            Browse {posts.length} posts by year and category.
          </h1>
          <p className="max-w-2xl font-serif text-[16px] text-muted-foreground">
            A complete index of everything published here, from quick notes to long-form essays.
          </p>
        </div>

        <ArchiveList posts={posts} categories={categories} />
      </main>
    </div>
  );
}
