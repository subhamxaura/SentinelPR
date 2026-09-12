import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import "./globals.css";

export const metadata: Metadata = {
  title: "SentinelPR — PR Quality, Visual Regression & Synthetic Monitoring",
  description:
    "Autonomous PR quality, visual regression and synthetic monitoring platform. Connects code changes to user experience and production reliability.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Runtime font loading with system-font fallbacks — degrades gracefully offline */}
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-bg text-text">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
