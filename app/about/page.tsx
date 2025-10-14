import { Header } from "@/components/header";

export default function About() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-2xl px-6 py-12">
        <h1 className="mb-8 text-2xl font-medium text-foreground">About</h1>

        <div className="space-y-4 text-[15px] leading-relaxed text-muted-foreground">
          <p>
            I'm a distributed systems engineer with a passion for building reliable, scalable
            infrastructure. I spend my days thinking about consensus algorithms, database internals,
            and how to make systems that don't fall over.
          </p>

          <p>
            This blog is where I write about the technical challenges I encounter and the solutions
            I discover. Topics include distributed systems, database design, query optimization, and
            software architecture.
          </p>

          <p>
            When I'm not debugging distributed systems, you can find me reading papers from academic
            conferences, contributing to open source projects, or experimenting with new database
            technologies.
          </p>

          <p className="text-muted-foreground/70">
            All opinions are my own and don't represent my employer.
          </p>
        </div>
      </main>
    </div>
  );
}
