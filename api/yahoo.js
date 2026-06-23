export default async function handler(req, res) {
  const { interval, range, period1, period2, includePrePost, modules, symbol } = req.query;
  const ticker = symbol || 'INTC';

  let url;
  if (modules) {
    // quoteSummary endpoint
    url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
  } else {
    // chart endpoint
    url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval || '5m'}`;
    if (period1 && period2) {
      url += `&period1=${period1}&period2=${period2}`;
    } else {
      url += `&range=${range || '1d'}`;
    }
    if (includePrePost) url += '&includePrePost=true';
  }

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const data = await response.json();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
