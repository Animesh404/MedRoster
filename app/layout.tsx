import type { Metadata } from "next";
import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { currentTheme } from "@/lib/theme/server";
import "./globals.css";

// Display face — hero and section heads only (§app/globals.css). Variable
// weight gives large type real character without shipping every static cut.
const bricolage = Bricolage_Grotesque({
  variable: "--font-bricolage",
  subsets: ["latin"],
});

// Body/UI face — built for technical work, legible at the small sizes a dense
// rota needs.
const plexSans = IBM_Plex_Sans({
  variable: "--font-plex-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

// Times, counts, IDs, issue codes. Tabular figures matter: a column of
// 07:30-15:30 must align down a week grid.
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "MedRoster",
  description: "Clinic staff shift scheduling",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read on the server so the very first byte carries the right theme. The
  // usual alternative — a blocking inline script that reads localStorage before
  // paint — exists only because the server cannot see localStorage; a cookie it
  // can see removes the need for the script entirely.
  const theme = await currentTheme();

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${bricolage.variable} ${plexSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <Toaster />
      </body>
    </html>
  );
}
