// Scheduled background job (run via .github/workflows/refresh-reasons.yml) that
// pre-computes "why is it moving" text for every watchlist ticker + the NASDAQ 100
// index, and writes it to data/reasons.json. The live dashboard only ever READS
// this static file — it never calls /api/groq directly — so every page load shows
// the exact same stable text until the next scheduled run, instead of a fresh
// (and sometimes rate-limited/flaky) LLM call on every visit.
import fs from 'node:fs/promises';

const SITE = 'https://intc-dashboard.vercel.app';
const OUT_PATH = new URL('../../data/reasons.json', import.meta.url);

// Must match the STOCK_META keys in api/groq.js
const TICKERS = [
  'INTC', 'AMD', 'NVDA', 'TSM', 'SNDK', 'MU', 'AVGO', 'SPCX',
  'MRVL', 'ARM', 'QCOM', 'SKHY', 'MBLY', '005930.KS', '000660.KS',
];

async function fetchChgPct(ticker) {
  // interval=1d&range=5d leaves meta.previousClose EMPTY for many tickers (forcing a
  // fallback to chartPreviousClose, which can be stale by more than a day per prior
  // findings in this repo) — interval=1m&range=2d is what the live dashboard cards use
  // and reliably populates meta.previousClose, so use the same variant here to make
  // sure the pct fed into the reason generator matches what's actually on-screen.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=2d&includePrePost=true`;
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return null;
  const data = await resp.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const price = meta.regularMarketPrice;
  const prevClose = meta.previousClose;
  if (price == null || !prevClose) return null;
  return ((price - prevClose) / prevClose) * 100;
}

async function fetchReason(query) {
  const resp = await fetch(`${SITE}/api/groq?${query}`);
  if (!resp.ok) return null;
  return resp.json();
}

function sameArticleSet(a, b) {
  if (!a?.length || !b?.length) return false;
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Only overwrite a stored entry when the new result is backed by a genuinely
// different set of articles. A "no catalyst" or failed call never downgrades
// an existing good entry — that's the actual cause of the old flakiness.
// `degraded` results (Groq rate-limited / errored mid-pipeline) are treated the
// same as a failed fetch — never trusted as ground truth, never used to overwrite.
function mergeEntry(prev, fresh) {
  if (!fresh || fresh.degraded) return prev || null;
  if (fresh.articleIds?.length) {
    // LLM-generated, article-backed result — only replace if the underlying news
    // actually changed, to avoid re-rolling the same story into slightly different wording.
    if (prev && sameArticleSet(prev.articleIds, fresh.articleIds)) return prev;
    return { text: fresh.text, source: fresh.source, articleIds: fresh.articleIds, updatedAt: new Date().toISOString() };
  }
  // Deterministic, non-LLM tiers (the fixed "no company-specific news" label, or a
  // genuine tier-3 "no catalyst") — always trust a successful (non-degraded) result,
  // there's no LLM re-rolling risk here to protect against.
  return { text: fresh.text, source: fresh.source, articleIds: [], updatedAt: new Date().toISOString() };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(OUT_PATH, 'utf8'));
  } catch {
    // First run — no prior file yet.
  }

  const result = {};

  for (const ticker of TICKERS) {
    const pct = await fetchChgPct(ticker);
    if (pct == null) {
      if (existing[ticker]) result[ticker] = existing[ticker];
      continue;
    }
    const fresh = await fetchReason(`ticker=${encodeURIComponent(ticker)}&chgPct=${pct}`);
    result[ticker] = mergeEntry(existing[ticker], fresh);
    // Space out requests — bursting 15+ calls in a few seconds is what was tripping
    // Groq's rate limit and causing spurious "degraded" results on the very first run.
    await sleep(4000);
  }

  // NASDAQ 100 / watchlist market-cap line share the same macro-level explanation.
  const qqqPct = await fetchChgPct('QQQ');
  if (qqqPct != null) {
    const fresh = await fetchReason(`index=1&chgPct=${qqqPct}`);
    result.INDEX = mergeEntry(existing.INDEX, fresh);
  } else if (existing.INDEX) {
    result.INDEX = existing.INDEX;
  }

  await fs.mkdir(new URL('.', OUT_PATH), { recursive: true });
  await fs.writeFile(OUT_PATH, JSON.stringify(result, null, 2) + '\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
