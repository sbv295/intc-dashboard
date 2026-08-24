// Serverless proxy that turns today's price move + recent news into a 1-line
// "why is this stock moving" explanation. Groq key stays server-side only
// (process.env.GROQ_API_KEY, set in Vercel project settings — never in git).
// Plain REST calls (no groq-sdk dependency) to match this repo's zero-npm-deps convention.
// llama-3.3-70b-versatile and llama-3.1-8b-instant were both deprecated by Groq
// on 2026-08-16 (requests now 404 with model_not_found) — migrated to Groq's
// recommended replacements, which is what silently broke every AI summary that
// actually needed a Groq call (tier-2/tier-3 non-LLM fallbacks kept working fine,
// which is why the dashboard appeared to "only ever show the generic fallback").
const MODEL_PRIMARY = 'openai/gpt-oss-120b';
const MODEL_FALLBACK = 'openai/gpt-oss-20b'; // much higher free-tier rate limit, used when primary 429s

async function groqChatOnce(apiKey, model, messages, { temperature = 0.2, max_tokens = 60 } = {}) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Groq API error: ${resp.status} ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices[0].message.content.trim();
}

// Try the bigger/smarter model first; on ANY failure (rate limit, timeout, etc.)
// fall back to the smaller model so a single request never fails outright.
async function groqChat(apiKey, messages, opts) {
  try {
    return await groqChatOnce(apiKey, MODEL_PRIMARY, messages, opts);
  } catch (e) {
    return groqChatOnce(apiKey, MODEL_FALLBACK, messages, opts);
  }
}

// Whitelisted tickers only — an arbitrary/public `ticker` query param must not
// be able to burn API quota on unrelated symbols or prompt-inject via `company`.
const STOCK_META = {
  // Semicon watchlist
  'INTC': ['INTC', 'Intel'],
  'AMD': ['AMD'],
  'NVDA': ['NVDA', 'Nvidia', 'NVIDIA'],
  'TSM': ['TSM', 'TSMC'],
  'SNDK': ['SNDK', 'SanDisk', 'Sandisk'],
  'MU': ['MU', 'Micron'],
  'AVGO': ['AVGO', 'Broadcom'],
  'SPCX': ['SPCX', 'SpaceX'],
  'MRVL': ['MRVL', 'Marvell'],
  'ARM': ['ARM', 'Arm Holdings', 'Arm'],
  'QCOM': ['QCOM', 'Qualcomm'],
  'SKHY': ['SKHY', 'SK Hynix', 'SK hynix'],
  'MBLY': ['MBLY', 'Mobileye'],
  '005930.KS': ['Samsung'],
  '000660.KS': ['SK Hynix', 'SK hynix'],
  // IT watchlist
  'AAPL': ['AAPL', 'Apple'],
  'MSFT': ['MSFT', 'Microsoft'],
  'GOOGL': ['GOOGL', 'Google', 'Alphabet'],
  'AMZN': ['AMZN', 'Amazon'],
  'META': ['META', 'Meta'],
  // Indian market watchlist
  'HDFCBANK.NS': ['HDFC Bank'],
  'ICICIBANK.NS': ['ICICI', 'ICICI Bank'],
  'DEEPAKFERT.NS': ['Deepak Fertilisers'],
  'AARTIIND.NS': ['Aarti Industries'],
  'TCS.NS': ['TCS'],
  'INFY.NS': ['Infosys'],
  'RELIANCE.NS': ['Reliance', 'Reliance Industries'],
  'ASIANPAINT.NS': ['Asian Paints'],
};

// Index-mode macro reference per market — which ETF/index news feed to pull
// broad-market context from, and how to describe it in prompts.
const MARKETS = {
  US: { macroTicker: 'QQQ', subject: 'the broad US market' },
  IN: { macroTicker: '^NSEI', subject: 'the broad Indian market' },
};

function displayName(ticker) {
  const variants = STOCK_META[ticker];
  return variants[variants.length > 1 ? 1 : 0];
}

function marketDaysCutoff(n) {
  let cur = new Date();
  let counted = 0;
  while (counted < n) {
    cur = new Date(cur.getTime() - 24 * 3600 * 1000);
    if (cur.getUTCDay() >= 1 && cur.getUTCDay() <= 5) counted++;
  }
  cur.setUTCHours(0, 0, 0, 0);
  return cur;
}

async function fetchNews(symbol, count = 10) {
  const url = 'https://finance.yahoo.com/xhr/ncp?queryRef=latestNews&serviceKey=ncp_fin';
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ serviceConfig: { snippetCount: count, s: [symbol] } }),
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const stream = data?.data?.tickerStream?.stream || [];
  return stream.filter(a => !(a.ad && a.ad.length));
}

// "Roundup" articles (e.g. "Apple, Sandisk, SpaceX... Stocks That Explain Today's
// Market") list many companies in the title, but Yahoo's summary snippet usually
// only actually covers the first one or two — matching on title alone can pick up
// an article whose visible content is entirely about a DIFFERENT company. For these,
// additionally require the target name to appear in the summary itself.
function looksLikeRoundup(title) {
  return (title.match(/,/g) || []).length >= 2 || /stocks that explain|more stocks|earnings roundup/i.test(title);
}

function filterRelevant(articles, nameVariants, cutoff) {
  const relevant = [];
  for (const item of articles) {
    const c = item.content || {};
    const title = (c.title || '').trim();
    const summary = (c.summary || '').trim();
    const pubDate = c.pubDate;
    if (!pubDate) continue;
    const pubDt = new Date(pubDate);
    if (pubDt < cutoff) continue;
    const nameRe = (v) => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const titleMatch = nameVariants.some(v => nameRe(v).test(title));
    if (!titleMatch) continue;
    if (looksLikeRoundup(title) && !nameVariants.some(v => nameRe(v).test(summary))) continue;
    relevant.push({ id: item.id, pubDate, title, summary });
    if (relevant.length === 5) break;
  }
  return relevant;
}

async function classifySentiment(apiKey, subject, articles) {
  const list = articles.map((a, i) => `${i}. ${a.title}\n   ${a.summary}`).join('\n');
  const prompt = `For ${subject}, classify whether each article below (if it were the ONLY news driving it today) would most likely make it go UP or DOWN. Some articles may cover multiple companies — base your judgment ONLY on the parts specifically about ${subject}, ignoring information about other companies mentioned. Respond with ONLY a JSON array of length ${articles.length}, each element "UP" or "DOWN", e.g. ["UP","DOWN"]. No other text.\n\n${list}`;
  const content = await groqChat(apiKey, [{ role: 'user', content: prompt }], { temperature: 0 });
  try {
    return JSON.parse(content);
  } catch {
    return articles.map(() => null);
  }
}

async function generateSentence(apiKey, subject, direction, chgPct, articles) {
  const list = articles.map(a => `- [${a.pubDate}] ${a.title}\n  ${a.summary}`).join('\n');
  const prompt = `Context: ${subject} is currently ${direction.toLowerCase()} ${Math.abs(chgPct).toFixed(2)}% today.\n\nNews article(s) consistent with this move:\n${list}\n\nSome articles may mention other companies too \u2014 use ONLY the information specifically about ${subject}, ignoring parts about other companies. Write a phrase targeting 15 words (a little shorter or longer is fine, but stay concise) giving ONLY the causal reason, based only on these article(s). Do NOT restate the company/index name or generic words like "stock", "shares", "up", "down", "rises", "falls" \u2014 the reader already sees the name and direction elsewhere on the page. Start directly with the reason (e.g. "$15B stock sale sparking dilution concerns as it looks to fund its aggressive AI data-center build-out", not "Down due to a $15B stock sale"). Output ONLY the phrase, nothing else.`;
  return groqChat(apiKey, [{ role: 'user', content: prompt }], { temperature: 0.2, max_tokens: 55 });
}

// Signals that an article is about the broad market/macro conditions rather than
// a single company — used to prefer genuinely market-wide drivers (Fed, inflation,
// oil, rates, jobs data) over a single constituent's news for index-level
// explanations (NASDAQ 100), where "explained by one company" reads poorly.
// Deliberately excludes generic index names (Dow/S&P/Nasdaq) — those show up even
// in single-company headlines just for context (e.g. "...weighing on the Nasdaq").
const BROAD_MARKET_RE = /\b(Fed(?:eral Reserve)?|inflation|CPI|PPI|crude(?:\s?oil)?|oil prices?|Treasury|yields?|rate (?:cut|hike)|jobs report|unemployment|payrolls|GDP|tariffs?|recession|interest rates?|market[- ]wide|broad market|semiconductor ETFs?|sector ETFs?|equities|equity futures)\b/i;

function isBroadMarket(article) {
  return BROAD_MARKET_RE.test(article.title) || BROAD_MARKET_RE.test(article.summary);
}

// Any of our watchlist companies' display names, for excluding single-company
// headlines from the "broad market" bucket even when they mention Dow/Nasdaq in passing.
const ALL_COMPANY_NAMES = [...new Set(Object.values(STOCK_META).flat())];
function mentionsSingleCompany(article) {
  return ALL_COMPANY_NAMES.some(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(article.title));
}

// Shared macro/sector-wide explanation via a market's reference ETF/index news
// feed (QQQ for US, ^NSEI for India). Used as the primary (only) tier for
// index-level UI spots (NASDAQ 100 / NIFTY 50 line).
async function macroExplain(apiKey, subject, direction, pct, cutoff, { preferBroad = false, macroTicker = 'QQQ', sentimentSubject = 'the broad US stock market' } = {}) {
  const macroNews = await fetchNews(macroTicker, 10);
  let macroRelevant = macroNews
    .map(item => {
      const c = item.content || {};
      return { id: item.id, pubDate: c.pubDate, title: (c.title || '').trim(), summary: (c.summary || '').trim() };
    })
    .filter(a => a.pubDate && new Date(a.pubDate) >= cutoff && a.title);

  if (preferBroad) {
    // Prefer articles that are BOTH macro-flavored AND not just riding a single
    // company's headline; fall back progressively so we never end up empty-handed.
    const cleanBroad = macroRelevant.filter(a => isBroadMarket(a) && !mentionsSingleCompany(a));
    const anyBroad = macroRelevant.filter(isBroadMarket);
    if (cleanBroad.length) macroRelevant = cleanBroad;
    else if (anyBroad.length) macroRelevant = anyBroad;
  }
  macroRelevant = macroRelevant.slice(0, 5);

  if (!macroRelevant.length) return null;
  const macroSentiments = await classifySentiment(apiKey, sentimentSubject, macroRelevant);
  const macroMatching = macroRelevant.filter((_, i) => macroSentiments[i] === direction);
  if (!macroMatching.length) return null;
  const text = await generateSentence(apiKey, subject, direction, pct, macroMatching);
  return { text, source: 'macro', articleIds: macroMatching.map(a => a.id).filter(Boolean) };
}

// In-memory cache — survives across requests on the same warm serverless
// instance, cutting repeat Groq calls from page reloads/multiple tabs within
// the TTL window down to zero. Keyed loosely (rounded %) since the sentence
// doesn't need to change for every 0.01% price tick.
const CACHE_TTL_MS = 20 * 60 * 1000;
const cache = new Map();

function cacheKey(ticker, direction, pct) {
  return `${ticker}|${direction}|${Math.round(Math.abs(pct))}`;
}

function getCached(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
  return null;
}

function setCached(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ticker, chgPct, index, market } = req.query;
  const isIndexMode = index === '1';
  const marketCfg = MARKETS[market] || MARKETS.US;
  if (!isIndexMode && (!ticker || !STOCK_META[ticker])) {
    return res.status(400).json({ error: 'Unknown ticker' });
  }
  const pct = parseFloat(chgPct);
  if (Number.isNaN(pct)) {
    return res.status(400).json({ error: 'Invalid chgPct' });
  }
  if (!process.env.GROQ_API_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const direction = pct > 0 ? 'UP' : 'DOWN';
  const key = cacheKey(isIndexMode ? `INDEX_${market || 'US'}` : ticker, direction, pct);
  const cached = getCached(key);
  if (cached) return res.status(200).json({ ...cached, cached: true });

  const apiKey = process.env.GROQ_API_KEY;
  // English-language news coverage for NSE-listed companies updates far less
  // frequently than US tech names — a 2-market-day cutoff was filtering out
  // genuinely relevant, on-topic articles almost every day, leaving Indian
  // stocks stuck on the generic "no company-specific news" fallback. Widen the
  // window to 7 market days (~10 calendar days) for India, keep the tighter
  // 2-day window for the fast-moving US market.
  const isIndiaRequest = market === 'IN' || (ticker && ticker.endsWith('.NS'));
  const cutoff = marketDaysCutoff(isIndiaRequest ? 7 : 2);

  // Every branch below must resolve to a result — the dashboard should never
  // show a blank line just because an LLM call failed. `degraded: true` marks
  // a result that came from an actual error (e.g. Groq rate-limited) rather
  // than the pipeline genuinely finding no catalyst — callers that persist
  // this (the scheduled background job) should NOT treat a degraded result
  // as ground truth and should keep whatever they had before instead.
  let result = null;
  let degraded = false;

  try {
    if (isIndexMode) {
      // Index/market-wide requests (NASDAQ 100 / NIFTY 50) go straight to the
      // macro tier — there's no single "company" catalyst to look for.
      // preferBroad: favor genuinely market-wide drivers (Fed/inflation/oil/rates)
      // over a single constituent's news, which reads poorly as an index-level reason.
      result = await macroExplain(apiKey, marketCfg.subject, direction, pct, cutoff, {
        preferBroad: true,
        macroTicker: marketCfg.macroTicker,
        sentimentSubject: marketCfg.subject,
      });
    } else {
      const nameVariants = STOCK_META[ticker];
      const subject = displayName(ticker);

      // Tier 1: stock-specific catalyst
      const news = await fetchNews(ticker);
      const relevant = filterRelevant(news, nameVariants, cutoff);
      if (relevant.length) {
        const sentiments = await classifySentiment(apiKey, subject, relevant);
        const matching = relevant.filter((_, i) => sentiments[i] === direction);
        if (matching.length) {
          const text = await generateSentence(apiKey, `${subject} (${ticker})`, direction, pct, matching);
          result = { text, source: 'stock', articleIds: matching.map(a => a.id).filter(Boolean) };
        }
      }

      // Tier 2: no company-specific catalyst found. Rather than forcing an LLM to
      // manufacture a company-specific-sounding reason out of generic market news
      // (this reliably produced either a leaked "I can't find anything" meta-comment
      // or an unconvincing forced rationalization — e.g. attributing Mobileye's move
      // to an unrelated Vanguard value-fund story), just show a short, honest,
      // non-LLM label. No Groq call needed for this tier at all.
      if (!result) {
        result = {
          text: direction === 'UP'
            ? 'No company-specific news \u2014 tracking a broader market/sector rally.'
            : 'No company-specific news \u2014 tracking a broader market/sector pullback.',
          source: 'macro-generic',
          articleIds: [],
        };
      }
    }
  } catch (e) {
    // A real failure (Groq rate limit, network error, etc.) happened somewhere
    // in the pipeline — fall through to the fallback text below, but flag it.
    degraded = true;
    if (req.query.debug) result = { text: '', source: 'error', articleIds: [], debugError: e.message };
  }

  // Tier 3: honest fallback — always non-empty, so every card shows *something*.
  if (!result) {
    result = { text: 'No plausible explanation for today\u2019s movement.', source: 'none', articleIds: [] };
  }
  if (degraded) result.degraded = true;

  if (!degraded) setCached(key, result);
  return res.status(200).json(result);
}
