import { Header } from "@/components/header";
import { ArchiveList } from "@/components/archive-list";
import { getAllCategories, getAllPosts } from "@/lib/posts";

export default function Archive() {
  const posts = getAllPosts();
  const categories = getAllCategories();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-12">
        <div className="mb-8">
          <h1 className="mb-3 text-2xl font-semibold text-foreground">Archive</h1>
          <p className="text-[14px] text-muted-foreground">
            Browse all {posts.length} posts organized by year and category
          </p>
        </div>

        <ArchiveList posts={posts} categories={categories} />
      </main>
    </div>
  );
}
