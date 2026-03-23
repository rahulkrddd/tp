const grid = document.getElementById("grid");
const asof = document.getElementById("asof");
const daysSel = document.getElementById("days");
const daysLbl = document.getElementById("daysLbl");
const refreshBtn = document.getElementById("refresh");

const AUTO_REFRESH_MS = 30 * 1000; // auto-refresh every 30s
let refreshTimer = null;

/* ===== Days cache config ===== */
const DAYS_STORAGE_KEY = "energy_dashboard_days";
const DEFAULT_DAYS = "4";

/* ===== Helpers ===== */
function clsForChange(txt) {
  if (!txt || txt === "—") return "neu";
  if (txt.trim().startsWith("+")) return "pos";
  if (txt.trim().startsWith("−") || txt.trim().startsWith("-")) return "neg";
  return "neu";
}

/* ===== Init dropdown from cache ===== */
function initDaysFromCache() {
  const saved = localStorage.getItem(DAYS_STORAGE_KEY);
  daysSel.value = saved || DEFAULT_DAYS;
}

/* ===== Render ===== */
function render(data) {
  if (!data || !data.rows) return;

  // dates: latest → oldest
  const dates = [...(data.dates || [])].reverse();

  // rows cells also reversed
  const rows = data.rows.map(r => ({
    ...r,
    cells: [...r.cells].reverse()
  }));

  daysLbl.textContent = dates.length;
  asof.textContent = `As of (UTC): ${new Date(data.generatedAtUTC).toLocaleString()}`;

  let thead = `
    <thead>
      <tr>
        <th class="indexCol" rowspan="2">Index</th>
        ${dates.map((d, i) => `
          <th class="group-${i}" colspan="2">${d.label}</th>
        `).join("")}
      </tr>
      <tr>
        ${dates.map((_, i) => `
          <th class="group-${i}">Value</th>
          <th class="group-${i}">% Change</th>
        `).join("")}
      </tr>
    </thead>
  `;

  let tbody = "<tbody>";
  for (const row of rows) {
    tbody += `
      <tr>
        <td class="indexCol">${row.name}</td>
        ${row.cells.map((c, i) => {
          const chgClass = clsForChange(c.changeAbs);
          const tip =
            c.carriedFrom && c.carriedFrom !== c.dateISO
              ? `title="Market closed on ${c.dateLabel}. Carried forward from ${c.carriedFrom}."`
              : `title="Close date: ${c.carriedFrom || "—"}"`;

          return `
            <td class="num group-${i}"
                data-date="${dates[i].label}"
                data-chg="${c.changeAbs} ${c.changePct}"
                data-chg-class="${chgClass}"
                ${tip}>
              ${c.value}
            </td>

            <td class="chg group-${i} ${chgClass}"
                data-date="${dates[i].label}"
                ${tip}>
              ${c.changeAbs} ${c.changePct}
            </td>
          `;
        }).join("")}
      </tr>
    `;
  }
  tbody += "</tbody>";

  grid.innerHTML = thead + tbody;
}

/* ===== Load ===== */
async function load() {
  try {
    const days = daysSel.value;
    const res = await fetch(`/api/dashboard?days=${days}`, { cache: "no-store" });
    const data = await res.json();

    if (data.error) {
      asof.textContent = `Error: ${data.error}`;
      return;
    }
    render(data);
  } catch (e) {
    asof.textContent = "Error loading data";
  }
}

/* ===== Events ===== */
refreshBtn.addEventListener("click", load);

daysSel.addEventListener("change", () => {
  localStorage.setItem(DAYS_STORAGE_KEY, daysSel.value);
  load();
});

/* ===== Auto refresh ===== */
function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(load, AUTO_REFRESH_MS);
}

/* ===== Init ===== */
initDaysFromCache();
load();
startAutoRefresh();
``
