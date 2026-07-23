let cachedCrumb = null;
let cachedCookie = null;
let crumbExpiry = 0;

async function getCrumb() {
  if (cachedCrumb && Date.now() < crumbExpiry) return { crumb: cachedCrumb, cookie: cachedCookie };

  // Step 1: Get consent cookie by visiting Yahoo
  const consentResp = await fetch('https://fc.yahoo.com/', {
    redirect: 'manual',
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const setCookies = consentResp.headers.get('set-cookie') || '';

  // Step 2: Get crumb using the cookie
  const crumbResp = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      'Cookie': setCookies.split(',').map(c => c.split(';')[0].trim()).join('; ')
    }
  });

  if (!crumbResp.ok) throw new Error('Failed to get crumb');
  const crumb = await crumbResp.text();
  const cookie = setCookies.split(',').map(c => c.split(';')[0].trim()).join('; ');

  cachedCrumb = crumb;
  cachedCookie = cookie;
  crumbExpiry = Date.now() + 3600000; // 1 hour

  return { crumb, cookie };
}

export default async function handler(req, res) {
  const { interval, range, period1, period2, includePrePost, modules, type, symbol } = req.query;
  const ticker = symbol || 'INTC';

  let url;
  let extraHeaders = { 'User-Agent': 'Mozilla/5.0' };

  if (modules) {
    // quoteSummary endpoint — needs crumb
    const { crumb, cookie } = await getCrumb();
    url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;
    extraHeaders['Cookie'] = cookie;
  } else if (type) {
    // fundamentals-timeseries endpoint (revenue/EPS history fallback when quoteSummary's
    // financialsChart is empty for a ticker) — needs crumb
    const { crumb, cookie } = await getCrumb();
    const now = Math.floor(Date.now() / 1000);
    const p1 = period1 || (now - 400 * 24 * 3600);
    const p2 = period2 || now;
    url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${ticker}?symbol=${ticker}&type=${type}&period1=${p1}&period2=${p2}&crumb=${encodeURIComponent(crumb)}`;
    extraHeaders['Cookie'] = cookie;
  } else {
    // chart endpoint — no crumb needed
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval || '5m'}`;
    if (period1 && period2) {
      url += `&period1=${period1}&period2=${period2}`;
    } else {
      url += `&range=${range || '1d'}`;
    }
    if (includePrePost) url += '&includePrePost=true';
  }

  try {
    const response = await fetch(url, { headers: extraHeaders });
    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
