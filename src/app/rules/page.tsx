import { ALL_RULES } from "@/lib/rules/engine";
import { PageHeader, Card, SeverityBadge, StatusBadge } from "@/components/primitives";

export const dynamic = "force-dynamic";

export default function RulesPage() {
  const rules = ALL_RULES;

  return (
    <div>
      <PageHeader
        title="Rules"
        description="The deterministic rule engine — every rule runs on every review, no AI required."
      />

      <Card className="px-4 py-3 text-[13px] text-muted">
        Rules receive each changed hunk (added lines with line numbers) and emit normalized findings with
        severity and confidence. Repo-level config can disable rules, override severities, tune thresholds
        and declare forbidden imports — see <span className="font-mono text-xs">Repositories</span>.
        Findings below the confidence threshold are stored but never commented on GitHub.
      </Card>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {rules.map((rule) => (
          <Card key={rule.id} className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs text-accent-strong">{rule.id}</span>
              <SeverityBadge severity={rule.severity} />
            </div>
            <h3 className="mt-1.5 text-[13px] font-medium">{rule.name}</h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">{rule.description}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <StatusBadge tone="neutral">{rule.category}</StatusBadge>
              <StatusBadge tone="accent">{rule.kind}</StatusBadge>
              <StatusBadge tone="neutral">scope: {rule.scope}</StatusBadge>
              <StatusBadge tone="neutral">confidence {(rule.confidence * 100).toFixed(0)}%</StatusBadge>
              {rule.scope === "file" && rule.languages ? (
                <StatusBadge tone="neutral">{rule.languages.join(", ")}</StatusBadge>
              ) : null}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
