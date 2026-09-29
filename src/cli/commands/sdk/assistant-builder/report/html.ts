import { classifyIteration, type ClassifiedCheck } from "./compare.js";
import type { ReportSummary } from "./summary.js";
import type { IterationData } from "./workspace.js";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const STYLE = `
:root{--bg:#1A1A1A;--card:#151515;--elev:#212224;--border:#333436;--text:#FFFFFF;--muted:#BBBBBB;
--ok:#259F4C;--ok-bg:#1B271F;--err:#F9303C;--err-bg:#262121;--warn:#E8A33D;
--font:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;--mono:'JetBrains Mono','Fira Code',monospace}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font)}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:24px;margin:0 0 4px}h2{font-size:16px;color:var(--muted);margin:32px 0 12px}
.meta{color:var(--muted)}.cards{display:flex;flex-wrap:wrap;gap:12px;margin-top:16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:12px 16px;min-width:140px}
.card b{display:block;font-size:20px}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:8px}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--border);vertical-align:top}th{background:var(--elev);color:var(--muted);font-weight:500}
.pass{color:var(--ok)}.fail,.regressed{color:var(--err)}.error,.blocked,.not_graded{color:var(--warn)}
details{background:var(--card);border:1px solid var(--border);border-radius:8px;margin:8px 0;padding:8px 12px}
summary{cursor:pointer}pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 var(--mono);background:var(--elev);padding:8px;border-radius:6px}
.bar{display:inline-block;height:8px;background:var(--ok);border-radius:4px;vertical-align:middle}`;

const VERDICT_CLASSES = new Set(["pass", "fail", "error", "blocked"]);

function statusCell(check: ClassifiedCheck): string {
  const verdict = check.verdict && VERDICT_CLASSES.has(check.verdict) ? check.verdict : "not_graded";
  return `<span class="${verdict}">${escapeHtml(verdict)}</span> <span class="meta">${escapeHtml(check.status.replace(/_/g, " "))}</span>`;
}

function roundsTable(summary: ReportSummary, iterations: IterationData[]): string {
  const rows = summary.rounds.map((round) => {
    const change = iterations.find((i) => i.version === round.version)?.change ?? "";
    const width = round.total ? Math.round((round.passed / round.total) * 120) : 0;
    return `<tr><td>v${round.version}${round.version === summary.best_version ? " ★" : ""}</td>
<td>${round.graded ? `<span class="bar" style="width:${width}px"></span> ${round.passed}/${round.total}` : '<span class="not_graded">not graded</span>'}</td>
<td class="fail">${escapeHtml(round.regressed.join(", "))}</td><td class="pass">${escapeHtml(round.fixed.join(", "))}</td>
<td><pre>${escapeHtml(change.trim())}</pre></td></tr>`;
  });
  return `<table><tr><th>Version</th><th>Passing</th><th>Regressed</th><th>Fixed</th><th>What changed</th></tr>${rows.join("")}</table>`;
}

function scenarioPanels(latest: IterationData, classified: ClassifiedCheck[]): string {
  return (latest.scenarios?.scenarios ?? [])
    .map((scenario) => {
      const result = latest.results.get(scenario.id);
      const checks = classified.filter((c) => c.scenario_id === scenario.id);
      const passed = checks.filter((c) => c.verdict === "pass").length;
      const turns = (result?.turns ?? [])
        .map((turn) => {
          const tools = turn.tool_calls
            .map((t) => `<li>${escapeHtml(t.name)}${t.error ? ' <span class="fail">error</span>' : ""}<pre>${escapeHtml(t.input)}\n→ ${escapeHtml(t.output_excerpt)}</pre></li>`)
            .join("");
          return `<p><b>User:</b></p><pre>${escapeHtml(turn.user)}</pre><p><b>Assistant</b> <span class="meta">${escapeHtml(String(turn.latency_ms))} ms · ${escapeHtml(String(turn.tokens ?? "?"))} tokens</span></p><pre>${escapeHtml(turn.assistant)}</pre>${tools ? `<ul>${tools}</ul>` : ""}`;
        })
        .join("");
      const error = result?.status === "error" ? `<p class="error">Run error: ${escapeHtml(result.error_message ?? "unknown")}</p>` : "";
      const checkRows = checks
        .map((c) => `<tr><td>${escapeHtml(c.check_id)}</td><td>${escapeHtml(c.text)}</td><td>${statusCell(c)}</td><td>${escapeHtml(c.reason)}</td></tr>`)
        .join("");
      return `<details${passed < checks.length ? " open" : ""}><summary>${escapeHtml(scenario.title)} <span class="meta">(${escapeHtml(scenario.id)}) · ${passed}/${checks.length}</span></summary>
${error}<table><tr><th>Check</th><th>Expectation</th><th>Verdict</th><th>Reason</th></tr>${checkRows}</table>${turns}</details>`;
    })
    .join("");
}

export function renderHtmlReport(input: { assistantName: string; summary: ReportSummary; iterations: IterationData[] }): string {
  const { summary, iterations } = input;
  const latest = iterations[iterations.length - 1];
  const previous = iterations.length > 1 ? iterations[iterations.length - 2] : undefined;
  const classified = classifyIteration(latest, previous);
  const observations = summary.observations.map((o) => `<li>${escapeHtml(o)}</li>`).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(input.assistantName)} · Assistant Test Report</title><style>${STYLE}</style></head>
<body><main>
<h1>${escapeHtml(input.assistantName)}</h1>
<div class="meta">Latest v${summary.latest_version}${summary.best_version !== null ? ` · best v${summary.best_version}` : ""}</div>
<div class="cards">
<div class="card"><span class="meta">Passing</span><b>${summary.latest.passed}/${summary.latest.total}</b></div>
<div class="card"><span class="meta">Fixed</span><b class="pass">${summary.latest.fixed.length}</b></div>
<div class="card"><span class="meta">Regressed</span><b class="fail">${summary.latest.regressed.length}</b></div>
<div class="card"><span class="meta">Rounds</span><b>${summary.rounds.length}</b></div>
</div>
<h2>Rounds</h2>${roundsTable(summary, iterations)}
${observations ? `<h2>Observations</h2><ul>${observations}</ul>` : ""}
<h2>Scenarios (v${latest.version})</h2>${scenarioPanels(latest, classified)}
</main></body></html>
`;
}
