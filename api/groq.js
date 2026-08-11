// Serverless proxy that turns today's price move + recent news into a 1-line
// "why is this stock moving" explanation. Groq key stays server-side only
// (process.env.GROQ_API_KEY, set in Vercel project settings — never in git).
// Plain REST calls (no groq-sdk dependency) to match this repo's zero-npm-deps convention.
const MODEL_PRIMARY = 'llama-3.3-70b-versatile';
const MODEL_FALLBACK = 'llama-3.1-8b-instant'; // much higher free-tier rate limit, used when primary 429s

async function groqChatOnce(apiKey, model, messages, { temperature = 0.2, max_tokens = 60 } = {}) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens }),
  });
  if (!resp.ok) throw new Error(`Groq API error: ${resp.status}`);
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
    const titleMatch = nameVariants.some(v => new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(title));
    if (titleMatch) {
      relevant.push({ pubDate, title, summary });
      if (relevant.length === 5) break;
    }
  }
  return relevant;
}

async function classifySentiment(apiKey, subject, articles) {
  const list = articles.map((a, i) => `${i}. ${a.title}\n   ${a.summary}`).join('\n');
  const prompt = `For ${subject}, classify whether each article below (if it were the ONLY news driving it today) would most likely make it go UP or DOWN. Respond with ONLY a JSON array of length ${articles.length}, each element "UP" or "DOWN", e.g. ["UP","DOWN"]. No other text.\n\n${list}`;
  const content = await groqChat(apiKey, [{ role: 'user', content: prompt }], { temperature: 0 });
  try {
    return JSON.parse(content);
  } catch {
    return articles.map(() => null);
  }
}

async function generateSentence(apiKey, subject, direction, chgPct, articles) {
  const list = articles.map(a => `- [${a.pubDate}] ${a.title}\n  ${a.summary}`).join('\n');
  const prompt = `Context: ${subject} is currently ${direction.toLowerCase()} ${Math.abs(chgPct).toFixed(2)}% today.\n\nNews article(s) consistent with this move:\n${list}\n\nWrite a phrase targeting 15 words (a little shorter or longer is fine, but stay concise) giving ONLY the causal reason, based only on these article(s). Do NOT restate the company/index name or generic words like "stock", "shares", "up", "down", "rises", "falls" \u2014 the reader already sees the name and direction elsewhere on the page. Start directly with the reason (e.g. "$15B stock sale sparking dilution concerns as it looks to fund its aggressive AI data-center build-out", not "Down due to a $15B stock sale"). Output ONLY the phrase, nothing else.`;
  return groqChat(apiKey, [{ role: 'user', content: prompt }], { temperature: 0.2, max_tokens: 55 });
}

// Shared macro/sector-wide explanation via QQQ's own news feed. Used both as the
// tier-2 fallback for individual tickers and as the primary (only) tier for
// index-level UI spots (NASDAQ 100 line, watchlist market-cap line).
async function macroExplain(apiKey, subject, direction, pct, cutoff) {
  const macroNews = await fetchNews('QQQ', 10);
  const macroRelevant = macroNews
    .map(item => {
      const c = item.content || {};
      return { pubDate: c.pubDate, title: (c.title || '').trim(), summary: (c.summary || '').trim() };
    })
    .filter(a => a.pubDate && new Date(a.pubDate) >= cutoff && a.title)
    .slice(0, 5);
  if (!macroRelevant.length) return null;
  const macroSentiments = await classifySentiment(apiKey, 'the broad US stock market', macroRelevant);
  const macroMatching = macroRelevant.filter((_, i) => macroSentiments[i] === direction);
  if (!macroMatching.length) return null;
  const text = await generateSentence(apiKey, subject, direction, pct, macroMatching);
  return { text, source: 'macro' };
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

  const { ticker, chgPct, index } = req.query;
  const isIndexMode = index === '1';
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
  const key = cacheKey(isIndexMode ? 'INDEX' : ticker, direction, pct);
  const cached = getCached(key);
  if (cached) return res.status(200).json({ ...cached, cached: true });

  const apiKey = process.env.GROQ_API_KEY;
  const cutoff = marketDaysCutoff(2);

  // Every branch below must resolve to a result — the dashboard should never
  // show a blank line just because an LLM call failed.
  let result = null;

  try {
    if (isIndexMode) {
      // Index/market-wide requests (NASDAQ 100, watchlist mkt cap) go straight
      // to the macro tier — there's no single "company" catalyst to look for.
      result = await macroExplain(apiKey, 'the broad US market', direction, pct, cutoff);
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
          result = { text, source: 'stock' };
        }
      }

      // Tier 2: broad market / sector fallback via QQQ's own news feed
      if (!result) {
        result = await macroExplain(apiKey, `${subject} (${ticker})`, direction, pct, cutoff);
      }
    }
  } catch (e) {
    // Fall through to the last-resort branch below — never surface a 500 to the client.
  }

  // Tier 3: honest fallback — always non-empty, so every card shows *something*.
  if (!result) {
    result = { text: 'No plausible explanation for today\u2019s movement.', source: 'none' };
  }

  setCached(key, result);
  return res.status(200).json(result);
}
