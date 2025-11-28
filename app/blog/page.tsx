import { BlogList } from "@/components/blog-list";
import { Header } from "@/components/header";
import { getAllPosts, getAllCategories } from "@/lib/posts";

export default function BlogPage() {
  const posts = getAllPosts();
  const categories = getAllCategories();

  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <div className="mb-12">
          <h1 className="text-3xl font-bold text-foreground">All Posts</h1>
          {/* </CHANGE> */}
        </div>
        <BlogList posts={posts} categories={categories} />
      </main>
    </div>
  );
}
