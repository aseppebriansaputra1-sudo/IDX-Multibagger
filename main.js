const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
function createWindow() {
  const w = new BrowserWindow({ width: 1280, height: 800, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
  w.loadFile('index.html');
}

// ---- Yahoo Finance (tidak resmi): butuh cookie + crumb ----
const UA = { 'User-Agent': 'Mozilla/5.0' };
let auth = null;
async function getAuth(force) {
  if (auth && !force) return auth;
  const r = await fetch('https://fc.yahoo.com', { headers: UA, redirect: 'manual' });
  const ck = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const c = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, Cookie: ck } });
  const crumb = await c.text();
  if (!crumb || crumb.includes('<')) throw new Error('crumb gagal');
  return (auth = { ck, crumb });
}
const J = async (u, a) => {
  const r = await fetch(u, { headers: { ...UA, Cookie: a.ck } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
const raw = o => (o && typeof o === 'object' ? o.raw : o);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Harga, high 52 minggu, rata-rata nilai transaksi harian 60 hari (miliar Rp)
async function price(t) {
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${t}.JK?range=1y&interval=1d`, { headers: UA });
    const res = (await r.json()).chart.result[0], m = res.meta, q = res.indicators.quote[0], v = [];
    for (let i = Math.max(0, q.close.length - 60); i < q.close.length; i++)
      if (q.close[i] && q.volume[i]) v.push(q.close[i] * q.volume[i]);
    return { px: m.regularMarketPrice, hi: m.fiftyTwoWeekHigh, val: v.length ? v.reduce((a, b) => a + b) / v.length / 1e9 : null };
  } catch (e) { return null; }
}

const TYPES = ['TotalRevenue', 'NetIncome', 'BasicEPS', 'TotalAssets', 'OperatingCashFlow', 'LongTermDebt',
  'CurrentAssets', 'CurrentLiabilities', 'GrossProfit', 'OrdinarySharesNumber', 'EBIT', 'InvestedCapital'];

async function scan(t) {
  const s = t + '.JK';
  let a = await getAuth();
  const qUrl = x => `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${s}?modules=financialData,defaultKeyStatistics,summaryDetail,price,assetProfile&crumb=${encodeURIComponent(x.crumb)}`;
  let qs;
  try { qs = await J(qUrl(a), a); } catch (e) { a = await getAuth(true); qs = await J(qUrl(a), a); }
  const r0 = qs.quoteSummary.result[0];
  const fd = r0.financialData || {}, ks = r0.defaultKeyStatistics || {}, sd = r0.summaryDetail || {}, pr = r0.price || {}, ap = r0.assetProfile || {};

  const tsUrl = `https://query1.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${s}?type=${TYPES.map(x => 'annual' + x).join(',')}&period1=1483228800&period2=${Math.floor(Date.now() / 1000)}&crumb=${encodeURIComponent(a.crumb)}`;
  const ts = await J(tsUrl, a).catch(() => null);
  const S = {};
  ((ts && ts.timeseries && ts.timeseries.result) || []).forEach(x => {
    const k = x.meta.type[0];
    S[k.replace('annual', '')] = (x[k] || []).map(v => raw(v && v.reportedValue)).filter(v => v != null);
  });
  const g = (k, i = 0) => { const arr = S[k] || []; return arr[arr.length - 1 - i]; };
  const cagr = k => {
    const arr = S[k] || [], n = Math.min(arr.length - 1, 3);
    if (n < 1) return null;
    const st = arr[arr.length - 1 - n], en = arr[arr.length - 1];
    return st > 0 && en > 0 ? ((en / st) ** (1 / n) - 1) * 100 : null;
  };
  // Piotroski F-Score dari laporan tahunan (data kurang = sinyal dianggap gagal)
  const roa = i => g('NetIncome', i) / g('TotalAssets', i), cr = i => g('CurrentAssets', i) / g('CurrentLiabilities', i),
    gm = i => g('GrossProfit', i) / g('TotalRevenue', i), at = i => g('TotalRevenue', i) / g('TotalAssets', i),
    lv = i => (g('LongTermDebt', i) || 0) / g('TotalAssets', i), T = c => (c === true ? 1 : 0);
  const f = T(roa(0) > 0) + T(g('OperatingCashFlow', 0) > 0) + T(roa(0) > roa(1)) + T(g('OperatingCashFlow', 0) > g('NetIncome', 0)) +
    T(lv(0) < lv(1)) + T(cr(0) > cr(1)) + T(g('OrdinarySharesNumber', 0) <= g('OrdinarySharesNumber', 1)) + T(gm(0) > gm(1)) + T(at(0) > at(1));
  const roic = g('EBIT') && g('InvestedCapital') ? (g('EBIT') * 0.78 / g('InvestedCapital')) * 100 : null;
  const p = await price(t);
  await sleep(300);
  return {
    t, sec: ap.sector || 'Lainnya', px: p ? p.px : raw(pr.regularMarketPrice), hi: p && p.hi, val: p && p.val,
    mc: raw(pr.marketCap) / 1e12, roe: raw(fd.returnOnEquity) * 100, npm: raw(fd.profitMargins) * 100,
    der: raw(fd.debtToEquity) / 100, rg: cagr('TotalRevenue'), eg: cagr('BasicEPS') ?? cagr('NetIncome'),
    per: raw(sd.trailingPE), pbv: raw(ks.priceToBook), roic, f
  };
}
ipcMain.handle('price', (_e, t) => price(t));
ipcMain.handle('scan', async (_e, t) => { try { return await scan(t); } catch (e) { return null; } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
