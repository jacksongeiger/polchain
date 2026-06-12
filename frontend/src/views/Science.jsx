/**
 * Science — reviewer collateral: the measurements behind the claims.
 * Not part of the live demo; everything here is an append-only artifact from
 * zk/experiments/run.py that a skeptic can rerun.
 *
 * Two cards, one claim each:
 *   crossover — "proof cost scales as a measurable curve; this is the
 *                verification tax on consumer hardware today"
 *   cotrain   — "federated aggregation trains a model no participant could
 *                train alone, without anyone revealing their data"
 */
import { useEffect, useState } from "react";
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ComposedChart, Legend, Bar, BarChart, ReferenceLine,
} from "recharts";
import { ADMIN_API } from "../config";

function useExperiment(name) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    fetch(`${ADMIN_API}/api/experiments/${name}`)
      .then((r) => r.json())
      .then((d) => (d.ok ? setData(d) : setErr(d.error)))
      .catch((e) => setErr(e.message));
  }, [name]);
  return { data, err };
}

// ── Crossover card ──────────────────────────────────────────────────────────
function CrossoverCard() {
  const { data, err } = useExperiment("crossover");

  let rows = [];
  if (data) {
    rows = data.results
      .filter((r) => r.runs && r.runs.length > 0)
      .map((r) => {
        const proves = r.runs.map((x) => x.prove_s);
        const pks    = r.runs.map((x) => x.pk_gb);
        return {
          name: r.name,
          params: r.params,
          prove_s: +(proves.reduce((a, b) => a + b, 0) / proves.length).toFixed(1),
          pk_gb: +(pks.reduce((a, b) => a + b, 0) / pks.length).toFixed(2),
          logrows: r.runs[0].logrows,
        };
      });
  }
  const dnfs = data ? data.results.filter((r) => r.dnf) : [];

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Proof cost vs model size</div>
      <div style={S.cardClaim}>
        One proof = one batched forward pass over the 8-image challenge, weights
        private. Measured end-to-end on this project's prover (16 GB consumer
        hardware), not estimated.
      </div>
      {err && <div style={S.empty}>No artifact yet — run <code style={S.code}>zk/experiments/run.py --suite crossover</code>. {String(err)}</div>}
      {data && rows.length > 0 && (
        <>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={rows} margin={{ top: 10, right: 16, bottom: 6, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="params" scale="log" domain={["auto", "auto"]} type="number"
                     tickFormatter={(v) => `${Math.round(v / 1000)}k`}
                     stroke="var(--text-tertiary)" fontSize={10} fontFamily="var(--font-mono)" />
              <YAxis yAxisId="t" scale="log" domain={["auto", "auto"]}
                     tickFormatter={(v) => `${v}s`}
                     stroke="var(--text-tertiary)" fontSize={10} fontFamily="var(--font-mono)" />
              <Tooltip
                contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}
                formatter={(v, k) => [k === "prove_s" ? `${v}s` : `${v} GB`, k === "prove_s" ? "prove time" : "proving key"]}
                labelFormatter={(v) => `${Number(v).toLocaleString()} params`}
              />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
              <Line yAxisId="t" dataKey="prove_s" name="prove time (s)" stroke="var(--accent)"
                    strokeWidth={2} dot={{ r: 4 }} />
              <Line yAxisId="t" dataKey="pk_gb" name="proving key (GB)" stroke="var(--miner-beta)"
                    strokeWidth={1.5} strokeDasharray="5 3" dot={{ r: 3 }} />
            </ComposedChart>
          </ResponsiveContainer>
          <div style={S.footnote}>
            Log-log. The curve ends at the last measured point — no dotted
            extrapolation into wishes.{" "}
            {dnfs.length > 0 && (
              <>Ceiling on this machine: {dnfs.map((d) => d.name).join(", ")} did not finish
              ({dnfs[0].dnf?.slice(0, 80)}…).{" "}</>
            )}
            On-chain verification of the production circuit measured separately:
            1,851,050 gas on Base (hardhat) — fractions of a cent. External zkML
            progress (GPU provers, folding schemes) is a different proof system,
            not this curve.
          </div>
        </>
      )}
      {data && rows.length === 0 && <div style={S.empty}>Artifact present but no completed runs yet.</div>}
    </div>
  );
}

// ── Co-training card ────────────────────────────────────────────────────────
function CotrainCard() {
  const { data, err } = useExperiment("cotrain");

  let perClass = null, summary = null;
  if (data && data.results?.length) {
    summary = data.summary;
    const r = data.results[0];
    perClass = Array.from({ length: 10 }, (_, d) => ({
      digit: String(d),
      "P (sees 0-4)": Math.round((r.per_class_p_solo[d] ?? 0) * 100),
      "Q (sees 5-9)": Math.round((r.per_class_q_solo[d] ?? 0) * 100),
      "P+Q federated": Math.round((r.per_class_federated[d] ?? 0) * 100),
    }));
  }

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>Private-data co-training</div>
      <div style={S.cardClaim}>
        Miner P only ever sees digits 0-4; miner Q only 5-9. Neither dataset
        leaves its silo — only weight updates move. The merged model reads all
        ten digits. This is the capability a centralized trainer cannot buy:
        training on data that legally cannot be pooled.
      </div>
      {err && <div style={S.empty}>No artifact yet — run <code style={S.code}>zk/experiments/run.py --suite cotrain</code>. {String(err)}</div>}
      {perClass && (
        <>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={perClass} margin={{ top: 10, right: 16, bottom: 6, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="digit" stroke="var(--text-tertiary)" fontSize={11} fontFamily="var(--font-mono)" />
              <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`}
                     stroke="var(--text-tertiary)" fontSize={10} fontFamily="var(--font-mono)" />
              <Tooltip
                contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 8, fontFamily: "var(--font-mono)", fontSize: 11 }}
                formatter={(v) => `${v}%`}
              />
              <Legend wrapperStyle={{ fontSize: 11, fontFamily: "var(--font-mono)" }} />
              <ReferenceLine y={50} stroke="var(--border-strong)" strokeDasharray="4 4" />
              <Bar dataKey="P (sees 0-4)"   fill="var(--miner-alpha)" opacity={0.55} />
              <Bar dataKey="Q (sees 5-9)"   fill="var(--miner-beta)"  opacity={0.55} />
              <Bar dataKey="P+Q federated"  fill="var(--success)" />
            </BarChart>
          </ResponsiveContainer>
          {summary && (
            <div style={S.footnote}>
              {data.config.seeds.length} seeds: P-solo {Math.round(summary.p_solo_mean * 100)}% ·
              Q-solo {Math.round(summary.q_solo_mean * 100)}% ·
              federated {Math.round(summary.federated_mean * 100)}%
              (±{(summary.federated_std * 100).toFixed(1)}).
              {" "}{data.caveat}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Science() {
  return (
    <div>
      <div style={S.pageHeader}>
        <div style={S.pageTitle}>Science</div>
        <div style={S.pageSub}>
          Reviewer collateral — the measurements behind the claims. Not part of
          the live demo. Every chart is an append-only artifact from{" "}
          <code style={S.code}>zk/experiments/run.py</code>; rerun them yourself.
        </div>
      </div>
      <div style={S.grid}>
        <CrossoverCard />
        <CotrainCard />
      </div>
    </div>
  );
}

const S = {
  pageHeader: { marginBottom: 24 },
  pageTitle: {
    fontFamily: "var(--font-sans)", fontWeight: 700, fontSize: 22,
    color: "var(--text-primary)", letterSpacing: "-0.01em",
  },
  pageSub: {
    marginTop: 8, fontSize: 13, lineHeight: 1.6, color: "var(--text-secondary)",
    maxWidth: 720,
  },
  grid: { display: "grid", gridTemplateColumns: "1fr", gap: 20 },
  card: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius-xl)",
    padding: "22px 24px",
  },
  cardTitle: {
    fontFamily: "var(--font-sans)", fontWeight: 600, fontSize: 16,
    color: "var(--text-primary)", marginBottom: 8,
  },
  cardClaim: {
    fontSize: 12.5, lineHeight: 1.65, color: "var(--text-secondary)",
    marginBottom: 18, maxWidth: 760,
  },
  footnote: {
    marginTop: 12, fontSize: 11, lineHeight: 1.6, color: "var(--text-tertiary)",
    fontFamily: "var(--font-mono)",
  },
  empty: {
    padding: "28px 0", fontSize: 12, color: "var(--text-tertiary)",
    fontFamily: "var(--font-mono)",
  },
  code: {
    background: "var(--bg-overlay)", padding: "1px 6px", borderRadius: 4,
    fontFamily: "var(--font-mono)", fontSize: 11,
  },
};
