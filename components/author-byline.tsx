import Image from "next/image";

interface AuthorBylineProps {
  date: string;
  readTime: string;
}

export function AuthorByline({ date, readTime }: AuthorBylineProps) {
  return (
    <div className="flex items-center gap-3.5">
      <Image
        src="/author.png"
        alt="Amr Mubarak"
        width={40}
        height={40}
        className="rounded-full object-cover"
      />
      <div>
        <p className="font-geist text-[14px] font-medium text-foreground">Amr Mubarak</p>
        <p className="font-geist text-[12px] text-muted-foreground">
          {new Date(date).toLocaleDateString("en-US", {
            year: "numeric",
            month: "short",
            day: "numeric",
          })}{" "}
          &middot; {readTime}
        </p>
      </div>
    </div>
  );
}
