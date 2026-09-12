import Link from "next/link";
import { authMode } from "@/lib/auth/mode";
import { readSession } from "@/lib/auth/session-store";
import { prisma } from "@/lib/db";
import { defaultOrganization } from "@/lib/auth/provisioning";
import { Card, Button, Mono } from "@/components/primitives";
import { RequestAccessButton } from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; redirectTo?: string }>;
}) {
  const params = await searchParams;
  const mode = authMode();

  let membershipCount = 0;
  let sessionUser: { name: string | null; githubLogin: string | null; email: string } | null = null;
  if (mode === "oauth") {
    const session = await readSession();
    if (session) {
      sessionUser = { name: session.user.name, githubLogin: session.user.githubLogin, email: session.user.email };
      membershipCount = await prisma.organizationMember.count({ where: { userId: session.user.id } });
    }
  }

  // Fully signed in with memberships — nothing to do here.
  if (mode === "oauth" && sessionUser && membershipCount > 0) {
    const { redirect } = await import("next/navigation");
    redirect("/");
  }

  const redirectTo = params.redirectTo?.startsWith("/") ? params.redirectTo : "/";

  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center">
      <Card className="px-6 py-8">
        <div className="flex items-center gap-3">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="2.5" y="2.5" width="19" height="19" rx="4" stroke="#6366f1" strokeWidth="1.6" />
            <path d="M8 12.2l2.6 2.6L16.2 9" stroke="#818cf8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Sign in to SentinelPR</h1>
            <p className="text-xs text-faint">PR quality · visual regression · synthetic monitoring</p>
          </div>
        </div>

        {params.error ? (
          <p className="mt-5 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">{params.error}</p>
        ) : null}

        {mode === "local" ? (
          <div className="mt-5 space-y-3 text-[13px] text-muted">
            <p>
              This deployment runs in <strong>local single-operator mode</strong>: the dashboard is trusted and no sign-in is
              required.
            </p>
            <p className="text-xs text-faint">
              To enable multi-user access, set <Mono>SENTINEL_AUTH_MODE=oauth</Mono>, create a GitHub OAuth App with the
              callback <Mono>&lt;dashboard URL&gt;/api/auth/github/callback</Mono>, and set{" "}
              <Mono>AUTH_GITHUB_CLIENT_ID</Mono> / <Mono>AUTH_GITHUB_CLIENT_SECRET</Mono>.
            </p>
            <Link href="/">
              <Button variant="secondary">Go to dashboard</Button>
            </Link>
          </div>
        ) : sessionUser && membershipCount === 0 ? (
          <AccessPending email={sessionUser.email} githubLogin={sessionUser.githubLogin} name={sessionUser.name} />
        ) : (
          <div className="mt-6 space-y-4">
            <a href={`/api/auth/github?redirectTo=${encodeURIComponent(redirectTo)}`}>
              <Button variant="primary" className="w-full">
                Continue with GitHub
              </Button>
            </a>
            <p className="text-xs text-faint">
              Access is granted by organization membership. Ask an administrator to invite your GitHub account&apos;s
              verified email if you get an access-pending screen.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}

function SignOutButton() {
  return (
    <form action="/api/auth/signout" method="post">
      <Button type="submit" variant="secondary">
        Sign out
      </Button>
    </form>
  );
}

async function AccessPending({ email, githubLogin, name }: { email: string | null; githubLogin: string | null; name: string | null }) {
  // Surface prior request state so users aren't left guessing.
  let pendingStatus: string | null = null;
  if (email) {
    const org = await defaultOrganization();
    const latest = await prisma.accessRequest.findFirst({
      where: { organizationId: org.id, email, status: { in: ["pending", "denied"] } },
      orderBy: { createdAt: "desc" },
      select: { status: true },
    });
    pendingStatus = latest?.status ?? null;
  }

  return (
    <div className="mt-5 space-y-3 text-[13px] text-muted">
      <p>
        Signed in as <strong>{githubLogin ?? name ?? "GitHub user"}</strong>, but your account has no organization
        membership yet.
      </p>
      {pendingStatus === "pending" ? (
        <p className="rounded border border-accent/30 bg-accent-dim/40 px-3 py-2 text-xs">
          Your access request is pending — an administrator will review it soon.
        </p>
      ) : pendingStatus === "denied" ? (
        <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs">
          A previous request was denied. You can ask an administrator directly, or an invite may be created for your
          email.
        </p>
      ) : (
        <RequestAccessButton />
      )}
      <p className="text-xs text-faint">
        Alternatively, an administrator can create an invite for your verified GitHub email — access is granted on your
        next page load either way.
      </p>
      <SignOutButton />
    </div>
  );
}
