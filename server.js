// server.js
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

let API_HIT_COUNT = 0;
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



app.use(express.static(path.join(__dirname, "public")));

/**
 * Data source priority:
 * 1) Yahoo chart API (fast JSON)
 * 2) Yahoo CSV download (more complete daily history for some symbols)
 * 3) Eastmoney Kline (for certain China indices like 000908)
 * 4) Investing / MarketScreener fallbacks
 */



const INSTRUMENTS = [
  { name: "S&P 500 Energy Index", symbol: "^GSPE" },
  { name: "MSCI World Energy Index", symbol: "^106796-USD-STRD" },

  {
    name: "STOXX Europe 600 Oil & Gas",
    symbol: "SXEP.Z",
    fallbacks: [
      { type: "investing", url: "https://uk.investing.com/indices/stoxx-europe-600-oil---gas-historical-data" },
      { type: "marketscreener", url: "https://www.marketscreener.com/quote/index/STOXX-EUROPE-600-OIL-GAS--43470841/quotes/" }
    ]
  },

  {
    name: "FTSE 350 Oil & Gas Index",
    symbol: "NMX601010.FGI",
    fallbacks: [
      { type: "investing", url: "https://www.investing.com/indices/oil---gas-historical-data" },
      { type: "marketscreener", url: "https://www.marketscreener.com/quote/index/FTSE-350-OIL-GAS-AND-COAL-121229621/" }
    ]
  },

  { name: "S&P/ASX 200 Energy Index", symbol: "^AXEJ" },
  { name: "Nifty Energy Index", symbol: "^CNXENERGY" },

  // ✅ CSI 300 Energy Index - fix with Eastmoney Kline API
  // Eastmoney kline API usage is widely documented for daily kline data. [1](https://dxcportal-my.sharepoint.com/personal/rahul_gupta23_dxc_com/_layouts/15/Doc.aspx?sourcedoc=%7B2CDECAE3-9B26-48FB-9988-CA8B72EF69B9%7D&file=Vehicle%20Order%20Processing(VOP)_5302_ProductionSupportGuide%20V20.0.docx&action=default&mobileredirect=true&DefaultItemOpen=1)[2](https://dxcportal.sharepoint.com/sites/SMDevStudio/_layouts/15/Doc.aspx?sourcedoc=%7B95173F0D-69AB-49D9-A69F-DBE01DCBE747%7D&file=ServiceNow%20Template%20Foundation%20v1.27.xlsm&action=default&mobileredirect=true&DefaultItemOpen=1)
  {
    name: "CSI 300 Energy Index",
    symbol: "000908.SS",
    fallbacks: [
      { type: "eastmoney", secid: "1.000908" }, // index code 000908 on Shanghai market-style secid
      { type: "marketscreener", url: "https://www.marketscreener.com/quote/index/CHINA-SHANGHAI-CSI-300-EN-180586302/" }
    ]
  },

  {
    name: "S&P Global Clean Energy Index",
    symbol: "^SPGTCLEN",
    fallbacks: [
      { type: "investing", url: "https://www.investing.com/indices/s-p-global-clean-energy-historical-data" },
      { type: "marketscreener", url: "https://www.marketscreener.com/quote/index/S-P-GLOBAL-CLEAN-ENERGY-I-46870326/quotes/" }
    ]
  },

  { name: "Tata Power", symbol: "TATAPOWER.NS" }
];

/* =======================
   Date helpers
======================= */
function isoDateUTC(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function ddmmyyyyFromISO(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}
function lastNCalendarDatesUTC(n) {
  const dates = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(isoDateUTC(d));
  }
  return dates;
}
function isoToEpochSec(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return Math.floor(dt.getTime() / 1000);
}
function isoToYmd(iso) {
  return iso.replace(/-/g, "");
}

/* =======================
   Yahoo chart API (primary)
======================= */
async function fetchYahooDailySeries(symbol, range = "6mo") {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=1d&includePrePost=false`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo chart fetch failed for ${symbol}: ${res.status}`);

  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(`No chart.result for ${symbol}`);

  const timestamps = result.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const out = [];

  for (let i = 0; i < timestamps.length; i++) {
    const c = closes[i];
    if (c == null) continue;
    const dt = new Date(timestamps[i] * 1000);
    out.push({ iso: isoDateUTC(dt), close: c });
  }

  out.sort((a, b) => a.iso.localeCompare(b.iso));
  return out;
}

/* =======================
   Yahoo CSV download (secondary)
======================= */
async function fetchYahooCsvDailySeries(symbol, startISO, endISO) {
  const period1 = isoToEpochSec(startISO) - 60 * 24 * 3600; // 60 days earlier
  const period2 = isoToEpochSec(endISO) + 2 * 24 * 3600;    // 2 days after

  const url = `https://query1.finance.yahoo.com/v7/finance/download/${encodeURIComponent(
    symbol
  )}?period1=${period1}&period2=${period2}&interval=1d&events=history&includeAdjustedClose=true`;

  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Yahoo CSV fetch failed for ${symbol}: ${res.status}`);

  const csv = await res.text();
  const lines = csv.trim().split("\n");
  if (lines.length < 2) throw new Error(`Yahoo CSV empty for ${symbol}`);

  const header = lines[0].split(",");
  const dateIdx = header.indexOf("Date");
  const closeIdx = header.indexOf("Close");
  if (dateIdx === -1 || closeIdx === -1) throw new Error(`Yahoo CSV missing columns for ${symbol}`);

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const date = cols[dateIdx];
    const close = cols[closeIdx];
    if (!date || date === "null") continue;
    const closeNum = Number(close);
    if (!Number.isFinite(closeNum)) continue;
    out.push({ iso: date, close: closeNum }); // date already YYYY-MM-DD
  }

  out.sort((a, b) => a.iso.localeCompare(b.iso));
  return out;
}

/* =======================
   Eastmoney Kline (for China indices like 000908)
   API usage pattern documented by community examples. [1](https://dxcportal-my.sharepoint.com/personal/rahul_gupta23_dxc_com/_layouts/15/Doc.aspx?sourcedoc=%7B2CDECAE3-9B26-48FB-9988-CA8B72EF69B9%7D&file=Vehicle%20Order%20Processing(VOP)_5302_ProductionSupportGuide%20V20.0.docx&action=default&mobileredirect=true&DefaultItemOpen=1)[2](https://dxcportal.sharepoint.com/sites/SMDevStudio/_layouts/15/Doc.aspx?sourcedoc=%7B95173F0D-69AB-49D9-A69F-DBE01DCBE747%7D&file=ServiceNow%20Template%20Foundation%20v1.27.xlsm&action=default&mobileredirect=true&DefaultItemOpen=1)
======================= */
async function fetchEastmoneyKlineSeries(secid, startISO, endISO) {
  const base = "https://push2his.eastmoney.com/api/qt/stock/kline/get";
  const params = new URLSearchParams({
    secid,
    klt: "101", // daily
    fqt: "0",   // no adjust
    beg: isoToYmd(startISO),
    end: isoToYmd(endISO),
    fields1: "f1,f2,f3,f4,f5,f6",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    ut: "fa5fd1943c7b386f172d6893dbfba10b",
    rtntype: "6"
  });

  const res = await fetch(`${base}?${params.toString()}`, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Referer": "https://quote.eastmoney.com/",
      "Accept": "application/json, text/plain, */*"
    }
  });
  if (!res.ok) throw new Error(`Eastmoney kline fetch failed: ${res.status}`);

  const json = await res.json();
  const klines = json?.data?.klines || [];
  if (!klines.length) throw new Error("Eastmoney kline empty");

  // kline: "YYYY-MM-DD,open,close,high,low,vol,amount,..."
  const out = [];
  for (const line of klines) {
    const parts = line.split(",");
    const date = parts[0];
    const close = Number(parts[2]);
    if (date && Number.isFinite(close)) out.push({ iso: date, close });
  }

  out.sort((a, b) => a.iso.localeCompare(b.iso));
  return out;
}

/* =======================
   HTML -> text helper (REAL HTML tags)
======================= */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function parseNumberLoose(x) {
  if (x == null) return null;
  const cleaned = String(x).replace(/,/g, "").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/* =======================
   Investing fallback
======================= */
const MONTHS = { Jan:1, Feb:2, Mar:3, Apr:4, May:5, Jun:6, Jul:7, Aug:8, Sep:9, Oct:10, Nov:11, Dec:12 };

function investingDateToISO(s) {
  let m = s.match(/^([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1]];
    const day = Number(m[2]);
    const year = Number(m[3]);
    if (!mon) return null;
    return isoDateUTC(new Date(Date.UTC(year, mon - 1, day)));
  }
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = Number(m[2]);
    const year = Number(m[3]);
    return isoDateUTC(new Date(Date.UTC(year, mon - 1, day)));
  }
  return null;
}

async function fetchInvestingDailySeries(historyUrl) {
  const res = await fetch(historyUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
      "Referer": "https://www.investing.com/"
    }
  });
  if (!res.ok) throw new Error(`Investing fetch failed: ${res.status}`);

  const html = await res.text();
  const text = htmlToText(html);

  const patterns = [
    /([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})\s+([\d,]+(?:\.\d+)?)/g,
    /(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})\s+([\d,]+(?:\.\d+)?)/g
  ];

  const outMap = new Map();
  for (const re of patterns) {
    let match;
    while ((match = re.exec(text)) !== null) {
      const iso = investingDateToISO(match[1]);
      const close = parseNumberLoose(match[2]);
      if (iso && close != null) outMap.set(iso, close);
    }
  }

  const out = Array.from(outMap.entries()).map(([iso, close]) => ({ iso, close }))
    .sort((a, b) => a.iso.localeCompare(b.iso));

  if (out.length < 5) throw new Error("Investing parse too small (blocked or page changed)");
  return out;
}

/* =======================
   MarketScreener fallback
======================= */
function msDateToISO(s) {
  const m = s.match(/^(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const year = 2000 + Number(m[1]);
  const mon = Number(m[2]);
  const day = Number(m[3]);
  return isoDateUTC(new Date(Date.UTC(year, mon - 1, day)));
}

async function fetchMarketScreenerDailySeries(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9"
    }
  });
  if (!res.ok) throw new Error(`MarketScreener fetch failed: ${res.status}`);

  const html = await res.text();
  const text = htmlToText(html);

  const re = /(\d{2}-\d{2}-\d{2})\s+([\d,]+(?:\.\d+)?)/g;

  const outMap = new Map();
  let match;
  while ((match = re.exec(text)) !== null) {
    const iso = msDateToISO(match[1]);
    const close = parseNumberLoose(match[2]);
    if (iso && close != null) outMap.set(iso, close);
  }

  const out = Array.from(outMap.entries()).map(([iso, close]) => ({ iso, close }))
    .sort((a, b) => a.iso.localeCompare(b.iso));

  if (out.length < 3) throw new Error("MarketScreener parse too small (page changed)");
  return out;
}

/* =======================
   Coverage check (NO future carry)
======================= */
function hasBackfillCoverage(series, startISO, endISO) {
  if (!series || series.length === 0) return false;
  const hasAtOrBeforeStart = series[0].iso <= startISO;
  const hasWithinWindow = series.some(p => p.iso >= startISO && p.iso <= endISO);
  return hasAtOrBeforeStart && hasWithinWindow;
}

/* =======================
   Choose best series:
   Yahoo chart -> Yahoo CSV -> Eastmoney -> fallbacks
======================= */
async function fetchBestDailySeries(inst, startISO, endISO) {
  // 1) Yahoo chart
  try {
    const yahoo = await fetchYahooDailySeries(inst.symbol, "6mo");
    if (hasBackfillCoverage(yahoo, startISO, endISO)) return { series: yahoo, sourceUsed: "yahoo_chart" };
  } catch (_) {}

  // 2) Yahoo CSV
  try {
    const csvSeries = await fetchYahooCsvDailySeries(inst.symbol, startISO, endISO);
    if (hasBackfillCoverage(csvSeries, startISO, endISO)) return { series: csvSeries, sourceUsed: "yahoo_csv" };
  } catch (_) {}

  // 3) Fallbacks
  for (const fb of (inst.fallbacks || [])) {
    try {
      if (fb.type === "eastmoney") {
        const em = await fetchEastmoneyKlineSeries(fb.secid, startISO, endISO);
        if (hasBackfillCoverage(em, startISO, endISO)) return { series: em, sourceUsed: "eastmoney" };
      } else if (fb.type === "investing") {
        const inv = await fetchInvestingDailySeries(fb.url);
        if (hasBackfillCoverage(inv, startISO, endISO)) return { series: inv, sourceUsed: "investing" };
      } else if (fb.type === "marketscreener") {
        const ms = await fetchMarketScreenerDailySeries(fb.url);
        if (hasBackfillCoverage(ms, startISO, endISO)) return { series: ms, sourceUsed: "marketscreener" };
      }
    } catch (_) {}
  }

  // last resort
  const yahoo = await fetchYahooDailySeries(inst.symbol, "6mo");
  return { series: yahoo, sourceUsed: "yahoo(stale)" };
}

/* =======================
   Carry forward (no future carry)
======================= */
function carryForwardToCalendar(dailySeries, targetDatesISO) {
  const map = [];
  let j = 0;
  let last = null;

  for (const t of targetDatesISO) {
    while (j < dailySeries.length && dailySeries[j].iso <= t) {
      last = dailySeries[j];
      j++;
    }
    if (!last) map.push({ dateISO: t, close: null, sourcedFromISO: null });
    else map.push({ dateISO: t, close: last.close, sourcedFromISO: last.iso });
  }
  return map;
}

/* =======================
   Trading-day change
======================= */
function computeTradingChanges(aligned) {
  let lastTradingClose = null;

  return aligned.map(row => {
    const isTradingDay = row.sourcedFromISO && row.dateISO === row.sourcedFromISO;
    let tradingChange = null;

    if (isTradingDay && lastTradingClose !== null && row.close != null) {
      let diff = row.close - lastTradingClose;
      if (Math.abs(diff) < 1e-10) diff = 0;
      const pct = lastTradingClose === 0 ? 0 : (diff / lastTradingClose) * 100;
      tradingChange = { abs: diff, pct };
    }

    if (isTradingDay && row.close != null) lastTradingClose = row.close;

    return { ...row, tradingChange, isTradingDay };
  });
}

/* =======================
   Formatting
======================= */
function fmtNumber(x) {
  if (x == null || Number.isNaN(x)) return "—";
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtSigned(n) {
  if (n == null) return { sign: "", abs: "—" };
  if (n > 0) return { sign: "+", abs: Math.abs(n).toFixed(2) };
  if (n < 0) return { sign: "−", abs: Math.abs(n).toFixed(2) };
  return { sign: "", abs: "0.00" };
}

/* =======================
   API
======================= */
app.get("/api/dashboard", async (req, res) => {
  try {
    const days = Math.max(2, Math.min(10, parseInt(req.query.days || "6", 10)));

    const targetDates = lastNCalendarDatesUTC(days + 1);
    const startISO = targetDates[0];
    const endISO = targetDates[targetDates.length - 1];

    const rows = await Promise.all(
      INSTRUMENTS.map(async inst => {
        const { series, sourceUsed } = await fetchBestDailySeries(inst, startISO, endISO);
        const lastSourceDate = series.length ? series[series.length - 1].iso : null;

        const aligned = carryForwardToCalendar(series, targetDates);
        const withChanges = computeTradingChanges(aligned);

        const cells = withChanges.slice(1).map(p => {
          let changeAbs = "—";
          let changePct = "—";

          if (p.tradingChange) {
            const a = fmtSigned(p.tradingChange.abs);
            const p2 = fmtSigned(p.tradingChange.pct);
            changeAbs = `${a.sign}${a.abs}`;
            changePct = `(${p2.sign}${p2.abs}%)`;
          }

          return {
            dateISO: p.dateISO,
            dateLabel: ddmmyyyyFromISO(p.dateISO),
            value: fmtNumber(p.close),
            changeAbs,
            changePct,
            carriedFrom: p.sourcedFromISO || "—"
          };
        });

        return { name: inst.name, symbol: inst.symbol, sourceUsed, lastSourceDate, cells };
      })
    );

    res.json({
      generatedAtUTC: new Date().toISOString(),
      dates: targetDates.slice(1).map(d => ({ iso: d, label: ddmmyyyyFromISO(d) })),
      rows
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/", (_, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Energy dashboard running on http://localhost:${PORT}`));
