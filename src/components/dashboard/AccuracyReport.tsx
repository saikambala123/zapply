"use client";

import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/lib/client-api";

/**
 * Fill accuracy, per question.
 *
 * The point of this page is to make a wrong answer visible to someone who can
 * fix it, without waiting for anybody to describe it. Every accuracy problem the
 * extension has had was found the same way — on a real application, at night,
 * and reported from a photograph of a screen. The data to find them first was
 * being thrown away.
 *
 * The ordering is deliberate: worst first, not busiest first. A question asked
 * twice and answered wrong both times matters more than one asked fifty times
 * and always right, and a "most common fields" list would bury it.
 */

type Row = {
  key: string;
  sample: string;
  ats: string;
  ruleKey: string | null;
  source: string;
  inputType: string;
  fills: number;
  corrections: number;
  blanks: number;
  rejections: number;
  lastSeenAt?: string;
};

type Report = {
  totals: { fills: number; corrections: number; blanks: number; rejections: number };
  accuracy: number | null;
  atsList: string[];
  rows: Row[];
};

const SOURCE_LABEL: Record<string, string> = {
  profile: "profile",
  saved: "saved answer",
  ai: "drafted",
  blank: "left blank",
  unmatched: "no match",
};

export default function AccuracyReport() {
  const [report, setReport] = useState<Report | null>(null);
  const [ats, setAts] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    // apiGet returns a result envelope rather than throwing, so the failure
    // path is a branch here and not a catch.
    apiGet<Report>(`/api/telemetry/fields?ats=${encodeURIComponent(ats)}`)
      .then((res) => {
        if (!live) return;
        if (res.ok) { setReport(res.data); setError(null); }
        else setError(res.error || "Could not load the accuracy report.");
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ats]);

  // Anything the applicant had to correct, or the portal rejected, needs work.
  const problems = useMemo(
    () => (report?.rows ?? []).filter((r) => r.corrections > 0 || r.rejections > 0),
    [report]
  );
  const gaps = useMemo(
    () => (report?.rows ?? []).filter((r) => r.corrections === 0 && r.rejections === 0 && r.blanks > 0),
    [report]
  );

  if (loading) return <p className="text-sm text-ink-faint">Loading accuracy…</p>;
  if (error) return <p className="text-sm text-danger">{error}</p>;

  const totals = report?.totals;
  const nothingYet = !totals || totals.fills === 0;

  return (
    <section className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-ink">Fill accuracy</h2>
          <p className="text-[13px] text-ink-soft">
            Which questions Zapply gets wrong, worst first. Only the question text and the
            outcome are recorded — never your answers.
          </p>
        </div>
        {(report?.atsList.length ?? 0) > 1 && (
          <select
            value={ats}
            onChange={(e) => setAts(e.target.value)}
            className="rounded-lg border border-line bg-canvas px-3 py-1.5 text-[13px]"
          >
            <option value="all">All portals</option>
            {report?.atsList.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        )}
      </header>

      {nothingYet ? (
        <p className="rounded-xl border border-line bg-surface p-4 text-[13.5px] text-ink-soft">
          Nothing recorded yet. Fill an application with the extension and the results will
          appear here.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Right first time"
              value={report!.accuracy === null ? "—" : `${Math.round(report!.accuracy * 100)}%`}
              hint={`${totals!.fills} fields filled`}
            />
            <Stat label="You corrected" value={String(totals!.corrections)} hint="we got these wrong" tone="warn" />
            <Stat label="Portal rejected" value={String(totals!.rejections)} hint="filled but not accepted" tone="warn" />
            <Stat label="Left for you" value={String(totals!.blanks)} hint="nothing could answer them" />
          </div>

          {problems.length > 0 && (
            <Table
              title="Getting these wrong"
              caption="You retyped these after Zapply filled them, or the portal refused them."
              rows={problems}
            />
          )}

          {gaps.length > 0 && (
            <Table
              title="Nothing to answer with"
              caption="Zapply had no value for these. Adding them to your profile or saved answers fixes them."
              rows={gaps}
            />
          )}
        </>
      )}
    </section>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "warn" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-3">
      <p className="text-[11.5px] uppercase tracking-wide text-ink-faint">{label}</p>
      <p className={`mt-0.5 text-2xl font-semibold ${tone === "warn" ? "text-warn" : "text-ink"}`}>{value}</p>
      <p className="text-[11.5px] text-ink-faint">{hint}</p>
    </div>
  );
}

function Table({ title, caption, rows }: { title: string; caption: string; rows: Row[] }) {
  return (
    <div className="space-y-2">
      <div>
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        <p className="text-[12.5px] text-ink-soft">{caption}</p>
      </div>
      <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
        {rows.slice(0, 50).map((r) => (
          <li key={`${r.ats}-${r.key}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink" title={r.sample}>
              {r.sample || r.key}
            </span>
            <span className="chip">{r.ats}</span>
            <span className="chip">{SOURCE_LABEL[r.source] ?? r.source}</span>
            {r.ruleKey && <span className="chip" title="The rule that answered it">{r.ruleKey}</span>}
            <span className="text-[12.5px] tabular-nums text-ink-faint">
              {r.corrections > 0 && <b className="text-warn">{r.corrections} corrected</b>}
              {r.corrections > 0 && (r.rejections > 0 || r.fills > 0) && " · "}
              {r.rejections > 0 && <>{r.rejections} rejected · </>}
              {r.fills > 0 ? `${r.fills} filled` : `${r.blanks} skipped`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
