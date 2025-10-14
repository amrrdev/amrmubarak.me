import { BlogList } from "@/components/blog-list";
import { Header } from "@/components/header";

export default function BlogPage() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-[1000px] px-6 py-16">
        <div className="mb-12">
          <h1 className="text-3xl font-bold text-foreground">All Posts</h1>
          {/* </CHANGE> */}
        </div>
        <BlogList />
      </main>
    </div>
  );
}
