import { Header } from "@/components/header";

export default function About() {
  return (
    <div className="min-h-screen">
      <Header />
      <main className="mx-auto max-w-3xl px-6 py-16 md:py-20">
        <div className="mb-10 space-y-3">
          <p className="text-[12px] font-semibold uppercase tracking-[0.3em] text-muted-foreground">
            About
          </p>
          <h1 className="text-3xl font-semibold text-foreground md:text-4xl">
            Writing with a systems lens.
          </h1>
        </div>

        <div className="space-y-5 font-serif text-[17px] leading-relaxed text-muted-foreground">
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
