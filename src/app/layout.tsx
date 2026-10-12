import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import { IntroAnimation } from "./intro-animation";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Deep Current — whale intelligence",
  description: "Публичная аналитика сделок и позиций кошельков Hyperliquid.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="ru"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <template dangerouslySetInnerHTML={{ __html: "<!-- THESIS: trader quality is the primary object; refuse the generic crypto card dashboard. OWN-WORLD: near-black data terminal, hairline rules, compact controls, turquoise only for verified positive state. STORY: compare curated traders, inspect proof, then follow live actions. FIRST VIEWPORT: compact header, market tape, dense leaderboard, live evidence rail. FORM: HyperStats canon, pinned by the user; seed 5db2a494. FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md -->" }}/>
        <IntroAnimation />
        {children}
        <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
