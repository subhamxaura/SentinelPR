import { prisma } from "@/lib/db";
import { requirePageOrganization } from "@/lib/web/session";
import { authMode } from "@/lib/auth/mode";
import { timeAgo } from "@/lib/web/format";
import { canAssignRole, canModifyMember } from "@/lib/web/roles";
import { PageHeader, Card, CardHeader, StatusBadge, Mono } from "@/components/primitives";
import {
  DecideAccessRequestButton,
  InviteMemberForm,
  MemberRoleSelect,
  RemoveMemberButton,
  RevokeInviteButton,
} from "@/components/forms";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const ctx = await requirePageOrganization();

  // Local mode has no roles — show the roster but no invite management.
  const localMode = authMode() === "local";

  const members = await prisma.organizationMember.findMany({
    where: { organizationId: ctx.id },
    orderBy: { createdAt: "asc" },
    include: { user: { select: { id: true, email: true, name: true, githubLogin: true, avatarUrl: true } } },
  });

  const invites = localMode
    ? []
    : await prisma.organizationInvite.findMany({
        where: { organizationId: ctx.id, acceptedAt: null },
        orderBy: { createdAt: "desc" },
      });

  const accessRequests = localMode
    ? []
    : await prisma.accessRequest.findMany({
        where: { organizationId: ctx.id, status: "pending" },
        orderBy: { createdAt: "asc" },
      });

  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  const ownerCount = members.filter((m) => m.role === "owner").length;

  // Per-row editability, evaluated server-side with the same pure rules the
  // API enforces — the UI can never offer an action the API would reject.
  const memberRows = members.map((m) => ({
    id: m.id,
    user: m.user,
    role: m.role,
    createdAt: m.createdAt,
    edit: canModifyMember(ctx.role, m.role as "owner" | "admin" | "member", "member", {
      isSelf: !!ctx.user && m.user.id === ctx.user.id,
      ownerCount,
    }).allowed,
    assignableRoles: (["owner", "admin", "member"] as const).filter((r) => canAssignRole(ctx.role, r)),
  }));

  return (
    <div>
      <PageHeader title="Team" description="Who has access to this organization, and who is on the way." />

      {localMode ? (
        <Card className="mb-6 border-accent/25 bg-accent-dim/30 px-4 py-3">
          <p className="text-[13px] text-muted">
            This deployment runs in <strong>local single-operator mode</strong> — everyone shares one organization and
            role management is not applicable. Enable OAuth (<Mono>SENTINEL_AUTH_MODE=oauth</Mono>) for invite-based access.
          </p>
        </Card>
      ) : !isAdmin ? (
        <Card className="mb-6 border-amber-500/30 bg-amber-500/5 px-4 py-3">
          <h3 className="text-[13px] font-semibold">Admins only</h3>
          <p className="mt-1 text-xs text-muted">
            You are signed in as a <StatusBadge tone="neutral">member</StatusBadge>. Team management (invites, roles) is
            restricted to admins and owners.
          </p>
        </Card>
      ) : (
        <InviteMemberForm canInviteOwner={ctx.role === "owner"} />
      )}        <Card className="mb-6">
        <CardHeader title={`Members (${members.length})`} sub="Roles: owner > admin > member. Owners are immutable — promote, then self-demote to hand over." />
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-widest text-faint">
              <tr className="border-b border-line">
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Joined</th>
                {isAdmin ? <th className="px-4 py-2" /> : null}
              </tr>
            </thead>
            <tbody>
              {memberRows.map((m) => (
                <tr key={m.id} className="border-b border-line/60">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      {m.user.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={m.user.avatarUrl} alt="" width={22} height={22} className="h-[22px] w-[22px] rounded-full" />
                      ) : null}
                      <span className="font-medium">{m.user.name ?? m.user.githubLogin ?? "—"}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted">{m.user.email}</td>
                  <td className="px-4 py-2.5">
                    {m.edit ? (
                      <MemberRoleSelect memberId={m.id} currentRole={m.role} assignableRoles={m.assignableRoles} />
                    ) : (
                      <StatusBadge tone={m.role === "owner" ? "accent" : m.role === "admin" ? "warning" : "neutral"}>{m.role}</StatusBadge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs text-faint">{timeAgo(m.createdAt)}</td>
                  {isAdmin ? (
                    <td className="px-4 py-2.5 text-right">
                      {m.edit ? <RemoveMemberButton memberId={m.id} memberName={m.user.name ?? m.user.githubLogin ?? m.user.email} /> : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {accessRequests.length > 0 && isAdmin ? (
        <Card className="mb-6 border-accent/30">
          <CardHeader
            title={`Access requests (${accessRequests.length})`}
            sub="Signed-in GitHub users asking to join this organization. Approval takes effect immediately."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-widest text-faint">
                <tr className="border-b border-line">
                  <th className="px-4 py-2">User</th>
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Requested</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {accessRequests.map((r) => (
                  <tr key={r.id} className="border-b border-line/60">
                    <td className="px-4 py-2.5 font-medium">{r.githubLogin ?? r.email}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{r.email}</td>
                    <td className="px-4 py-2.5 text-xs text-faint">{timeAgo(r.createdAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="flex justify-end gap-2">
                        <DecideAccessRequestButton requestId={r.id} action="approve" />
                        <DecideAccessRequestButton requestId={r.id} action="deny" />
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      {invites.length > 0 ? (
        <Card>
          <CardHeader title={`Pending invites (${invites.length})`} sub="Consumed automatically at the invitee's next sign-in or page load." />
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="text-[11px] uppercase tracking-widest text-faint">
                <tr className="border-b border-line">
                  <th className="px-4 py-2">Email</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Invited</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {invites.map((inv) => (
                  <tr key={inv.id} className="border-b border-line/60">
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{inv.email}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge tone={inv.role === "owner" ? "accent" : inv.role === "admin" ? "warning" : "neutral"}>{inv.role}</StatusBadge>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-faint">{timeAgo(inv.createdAt)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <RevokeInviteButton inviteId={inv.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}