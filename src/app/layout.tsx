import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { Shell } from "@/components/shell";
import { resolveOrganization } from "@/lib/web/session";
import { authMode } from "@/lib/auth/mode";
import "./globals.css";

export const metadata: Metadata = {
  title: "SentinelPR — PR Quality, Visual Regression & Synthetic Monitoring",
  description:
    "Autonomous PR quality, visual regression and synthetic monitoring platform. Connects code changes to user experience and production reliability.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ctx = authMode() === "oauth" ? await resolveOrganization() : null;

  const memberships = ctx?.user
    ? await prisma.organizationMember.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: "asc" },
        select: { organizationId: true, role: true, organization: { select: { name: true } } },
      })
    : [];

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
        <Shell
          user={ctx?.user ? { name: ctx.user.name, githubLogin: ctx.user.githubLogin, avatarUrl: ctx.user.avatarUrl } : null}
          role={ctx?.role ?? null}
          activeOrg={{ id: ctx?.id ?? null, name: ctx?.name ?? null }}
          memberships={memberships.map((m) => ({ organizationId: m.organizationId, name: m.organization.name, role: m.role }))}
        >
          {children}
        </Shell>
      </body>
    </html>
  );
}
