import type React from "react";
import type { Metadata } from "next";
import { JetBrains_Mono, Fraunces, Plus_Jakarta_Sans } from "next/font/google";
import { GeistSans } from "geist/font/sans";
import { Analytics } from "@vercel/analytics/next";
import { Suspense } from "react";
import { ThemeProvider } from "@/components/theme-provider";
import { Footer } from "@/components/footer";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const plusJakartaSans = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-plus-jakarta",
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: {
    default: "Amr Mubarak — Thoughts on Engineering",
    template: "%s — Amr Mubarak",
  },
  description:
    "Technical writing on distributed systems, databases, and software engineering",
  metadataBase: new URL("https://amrmubarak.com"),
  openGraph: {
    title: "Amr Mubarak — Thoughts on Engineering",
    description:
      "Technical writing on distributed systems, databases, and software engineering",
    url: "https://amrmubarak.com",
    siteName: "Amr Mubarak",
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Amr Mubarak — Thoughts on Engineering",
    description:
      "Technical writing on distributed systems, databases, and software engineering",
  },
  robots: {
    index: true,
    follow: true,
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
  },
  other: {
    "apple-touch-icon": "/favicon.svg",
  },
};

const enableVercelAnalytics = process.env.NEXT_PUBLIC_ENABLE_VERCEL_ANALYTICS === "true";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${GeistSans.variable} ${fraunces.variable} ${plusJakartaSans.variable} ${jetbrainsMono.variable} font-geist antialiased`}
      >
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
          <div className="flex min-h-dvh flex-col">
            <Suspense fallback={<div>Loading...</div>}>
              <div className="flex-1">{children}</div>
            </Suspense>
            <Footer />
          </div>
          {enableVercelAnalytics ? <Analytics /> : null}
        </ThemeProvider>
      </body>
    </html>
  );
}
