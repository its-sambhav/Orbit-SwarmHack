/* Works Sanctioned - both Lok Sabha tenures (18th + 17th) -> one CSV.
   Paste into the DevTools console ON https://mplads.mospi.gov.in/digigov/dashboard.html
   Expected: ~172,049 rows (79,932 from 18th LS + 92,117 from 17th LS).       */
(async () => {
  const KEY = 'Works Sanctioned';
  const SCOPES = [['0,0,0,2,7', '18th Lok Sabha'], ['0,0,0,2,5', '17th Lok Sabha']];
  const EP = '/rest/PreLoginDashboardData/';

  const post = async (path, body) => {
    const r = await fetch(EP + path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json; charset=utf-8'},
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    // Server declares ISO-8859-1. r.json() would assume UTF-8 and corrupt bytes
    // like 0xD7 in "40x30feet", so decode explicitly.
    return JSON.parse(new TextDecoder('iso-8859-1').decode(await r.arrayBuffer()));
  };

  // payload is {label: "<json string>"} - the rows are JSON inside JSON
  const rowsOf = o => Object.values(o).flatMap(v => typeof v === 'string' ? JSON.parse(v) : v);
  // each payload ends with a grand-total row: every field blank except Total_Amt
  const isTotal = o => o.Total_Amt && !Object.entries(o).some(([k, v]) => k !== 'Total_Amt' && v);

  async function fetchScope(combo, label) {
    try {
      console.log(`  requesting whole scope - expect 1-3 min of nothing, do not navigate away`);
      const rows = rowsOf(await post('getTilesReportData', {combo, key: KEY}));
      console.log(`  got ${rows.length.toLocaleString()} rows`);
      return rows;
    } catch (e) {
      // this scope is the one MoSPI's server most often resets - chunk by state
      console.warn(`  whole scope failed (${e.message}) - retrying state by state`);
      const states = await post('getStateData', {});
      const out = [];
      for (const s of states) {
        const c = combo.replace(/^0/, s.STATE_ID);
        try {
          const rows = rowsOf(await post('getTilesReportData', {combo: c, key: KEY}));
          out.push(...rows);
          console.log(`    ${s.STATE_NAME.padEnd(34)} ${rows.length.toLocaleString().padStart(8)}`);
        } catch (e2) {
          console.error(`    ${s.STATE_NAME.padEnd(34)} FAILED - ${e2.message}`);
        }
      }
      return out;
    }
  }

  const all = [], totals = [];
  for (const [combo, label] of SCOPES) {
    console.log(`\n=== ${label} ===`);
    for (const r of await fetchScope(combo, label)) {
      if (isTotal(r)) { totals.push({tenure: label, Total_Amt: r.Total_Amt}); continue; }
      // Write to NEW keys only. This payload has its own TENURE field (the column
      // the dashboard labels "Elected/Nominated") - assigning to it would wipe it.
      r.SCOPE_HOUSE  = 'Lok Sabha';
      r.SCOPE_TENURE = label;
      all.push(r);
    }
  }

  if (!all.length) { console.error('nothing fetched'); return; }

  const seen = [...new Set(all.flatMap(Object.keys))];
  const cols = ['SCOPE_HOUSE', 'SCOPE_TENURE',
                ...seen.filter(c => c !== 'SCOPE_HOUSE' && c !== 'SCOPE_TENURE')];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...all.map(o => cols.map(c => esc(o[c])).join(','))].join('\r\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8'}));
  a.download = 'works_sanctioned_lok_sabha.csv';
  a.click();

  console.log(`\nDONE  ${all.length.toLocaleString()} rows x ${cols.length} cols`);
  console.log('grand totals reported by the API (excluded from the CSV):');
  console.table(totals);
})();
