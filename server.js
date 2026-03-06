/**
 * server.js — Monitor Passaggio a Livello Battaglia Terme · Monselice
 * Linea Venezia–Bologna
 *
 * Avvio: npm install && node server.js
 * Poi apri http://localhost:3000
 */

const express = require('express');
//const fetch   = require('node-fetch');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// CONFIGURAZIONE GEOGRAFICA
// ─────────────────────────────────────────────
const CONFIG = {
  stazioni: {
    MONSELICE: { id: 'S05703', nome: 'MONSELICE' },
    BOLOGNA:   { id: 'S05043', nome: 'BOLOGNA CENTRALE' },
  },

  // Minuti di percorrenza tra il PL e ciascuna stazione
  // PL è a nord di Monselice, sulla direttrice Venezia↔Bologna
  minuti_PL_da_monselice_nord: 3,  // treno PARTE da Monselice verso Venezia → arriva al PL in 3 min
  minuti_PL_arrivo_monselice:  5,  // treno ARRIVA a Monselice da Venezia → era al PL 5 min prima
  minuti_PL_da_bologna:       38,  // treno PARTE da Bologna verso Venezia → PL dopo ~38 min
  minuti_PL_arrivo_bologna:   38,  // treno ARRIVA a Bologna da Venezia → era al PL ~38 min prima

  pre_chiusura_default: 2,

  BASE_URL: 'http://www.viaggiatreno.it/infomobilita/resteasy/viaggiatreno',

  // ── FILTRO DIREZIONE ──────────────────────────────────────────
  // Whitelist: destinazioni "verso Venezia" (treni che passano dal PL)
  WHITELIST_VENEZIA: [
    'VENEZIA', 'MESTRE', 'PADOVA', 'VICENZA', 'VERONA', 'TRIESTE',
    'TREVISO', 'UDINE', 'PORDENONE', 'CASTELFRANCO', 'CITTADELLA',
    'CAMPOSAMPIERO', 'ROVIGO', 
  ],
  // Blacklist: destinazioni "verso Bologna" o linee laterali (NON passano dal PL)
  BLACKLIST_BOLOGNA: [
    'BOLOGNA', 'FERRARA', 'MANTOVA', 'LEGNAGO', 'MONSELICE',
    'ESTE', 'MONTAGNANA', 'ADRIA', 'CHIOGGIA',
  ],
};

// ─────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────
const cache = { data: null, ts: 0, TTL_MS: 20_000 };
function cacheValid() {
  return cache.data && (Date.now() - cache.ts) < cache.TTL_MS;
}

// ─────────────────────────────────────────────
// LOG CHIAMATE API
// ─────────────────────────────────────────────
const apiLog = [];

function addLog(entry) {
  apiLog.unshift(entry);
  if (apiLog.length > 30) apiLog.pop();
  const ok  = !entry.error && entry.status >= 200 && entry.status < 300;
  const col = ok ? '\x1b[32m' : '\x1b[31m';
  const rst = '\x1b[0m';
  console.log(
    `${col}[${entry.status || 'ERR'}]${rst} ${String(entry.ms).padStart(4)}ms` +
    `  ${entry.label.padEnd(28)}` +
    `  ${entry.items !== null ? String(entry.items).padStart(3) + ' items' : '   null '}` +
    `  ${entry.url}`
  );
  if (entry.error) console.error(`       └─ ${entry.error}`);
}

// ─────────────────────────────────────────────
// HELPER: formato data per ViaggiaTreno
// ─────────────────────────────────────────────
function vtDate() {
  return encodeURIComponent(new Date().toString());
}

// ─────────────────────────────────────────────
// CHIAMATA BASE API TRENITALIA
// ─────────────────────────────────────────────
async function vt(endpoint, label) {
  const url = CONFIG.BASE_URL + endpoint;
  const t0  = Date.now();
  let status = 0, error = null, result = null;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    status = res.status;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text && text.trim()) {
      try { result = JSON.parse(text); }
      catch (e) { error = 'JSON parse error: ' + e.message; }
    }
  } catch (e) {
    if (!error) error = e.message;
  }

  addLog({
    ts:    new Date().toISOString(),
    label,
    url,
    status,
    ms:    Date.now() - t0,
    items: Array.isArray(result) ? result.length : (result !== null ? '(obj)' : null),
    error,
  });

  if (error && result === null) throw new Error(error);
  return result;
}

async function getPartenze(stazioneId, nomeStazione) {
  try { return await vt(`/partenze/${stazioneId}/${vtDate()}`, `partenze  ${nomeStazione}`) ?? []; }
  catch { return []; }
}

async function getArrivi(stazioneId, nomeStazione) {
  try { return await vt(`/arrivi/${stazioneId}/${vtDate()}`, `arrivi    ${nomeStazione}`) ?? []; }
  catch { return []; }
}

async function getStatistiche() {
  try { return await vt(`/statistiche/${vtDate()}`, 'statistiche'); }
  catch { return null; }
}

// ─────────────────────────────────────────────
// FILTRO DIREZIONE
// Restituisce 'venezia' | 'bologna' | 'sconosciuta'
// ─────────────────────────────────────────────
function classificaDirezione(dest) {
  if (!dest) return 'sconosciuta';
  const d = dest.toUpperCase();

  // Controlla whitelist prima
  if (CONFIG.WHITELIST_VENEZIA.some(v => d.includes(v))) return 'venezia';
  // Poi blacklist
  if (CONFIG.BLACKLIST_BOLOGNA.some(v => d.includes(v))) return 'bologna';

  return 'sconosciuta';
}

// ─────────────────────────────────────────────
// CALCOLO ETA AL PASSAGGIO A LIVELLO
// Sorgenti possibili:
//   partMonselice_venezia  → parte da Monselice verso Venezia
//   arriviMonselice_venezia → arriva a Monselice provenendo da Venezia
//   arriviBologna_venezia  → arriva a Bologna provenendo da Venezia (treno di passaggio)
// ─────────────────────────────────────────────
function calcolaETA(treno, src) {
  const orario = treno.orarioPartenza ?? treno.orarioArrivo;
  if (!orario) return null;

  const ts = parseInt(orario);
  if (isNaN(ts)) return null;

  const ritardoMs  = (treno.ritardo ?? 0) * 60_000;
  const orarioEff  = ts + ritardoMs;

  let offsetMin;
  switch (src) {
    // Parte da Monselice verso Venezia: PL è 3 min dopo la partenza
    case 'partMonselice_venezia':
      offsetMin = +CONFIG.minuti_PL_da_monselice_nord;
      break;

    // Arriva a Monselice da Venezia: era al PL 5 min prima dell'arrivo
    case 'arriviMonselice_venezia':
      offsetMin = -CONFIG.minuti_PL_arrivo_monselice;
      break;

    // Arriva a Bologna da Venezia (treno di passaggio):
    // era al PL ~38 min prima dell'arrivo a Bologna
    case 'arriviBologna_venezia':
      offsetMin = -CONFIG.minuti_PL_da_bologna;
      break;

    default: return null;
  }

  const orarioPL = orarioEff + offsetMin * 60_000;
  const etaMin   = (orarioPL - Date.now()) / 60_000;

  // Finestra utile: da 10 min fa a 90 min nel futuro
  if (etaMin < -10 || etaMin > 90) return null;
  return Math.round(etaMin * 10) / 10;
}

// ─────────────────────────────────────────────
// RACCOLTA DATI PRINCIPALE
// ─────────────────────────────────────────────
async function raccogliTreni() {
  console.log('\n── Fetch ViaggiaTreno ──────────────────────────────────');

  const [
    partMons,
    arriviMons,
    arriviBologna,
    stat,
  ] = await Promise.all([
    getPartenze(CONFIG.stazioni.MONSELICE.id, 'Monselice'),
    getArrivi(CONFIG.stazioni.MONSELICE.id,   'Monselice'),
    getArrivi(CONFIG.stazioni.BOLOGNA.id,     'Bologna C.le'),
    getStatistiche(),
  ]);

  console.log('──────────────────────────────────────────────────────────\n');

  const mappa = new Map();

  // ── 1. PARTENZE DA MONSELICE verso Venezia ──
  for (const t of partMons) {
    if (!t?.numeroTreno) continue;
    const dest = t.destinazione ?? t.compDestinazioneTreno ?? '';
    const dir  = classificaDirezione(dest);
    if (dir !== 'venezia') continue;   // ignora treni verso Bologna/Rovigo/Mantova/Legnago

    const eta = calcolaETA(t, 'partMonselice_venezia');
    if (eta === null) continue;

    mappa.set(String(t.numeroTreno), {
      numero:        t.numeroTreno,
      categoria:     t.categoria ?? 'R',
      destinazione:  dest || '—',
      origine:       t.origine ?? '—',
      ritardo:       t.ritardo ?? 0,
      eta_min:       eta,
      src:           'partMonselice_venezia',
      direzione:     '→ Venezia',
      fonte:         'Monselice partenze',
      binario:       t.binarioProgrammatoPartenzaDescrizione ?? null,
      provvedimento: t.provvedimento ?? 0,
    });
  }

  // ── 2. ARRIVI A MONSELICE da Venezia ──
  for (const t of arriviMons) {
    if (!t?.numeroTreno) continue;
    const key    = String(t.numeroTreno);
    if (mappa.has(key)) continue; // già trovato nelle partenze

    // Per gli arrivi guardiamo l'ORIGINE, non la destinazione
    const orig = t.origine ?? t.compOrigineZeroEffettivo ?? '';
    const dir  = classificaDirezione(orig);
    if (dir !== 'venezia') continue;  // arriva da Bologna → non passa dal PL

    const eta = calcolaETA(t, 'arriviMonselice_venezia');
    if (eta === null) continue;

    mappa.set(key, {
      numero:        t.numeroTreno,
      categoria:     t.categoria ?? 'R',
      destinazione:  t.destinazione ?? '—',
      origine:       orig || '—',
      ritardo:       t.ritardo ?? 0,
      eta_min:       eta,
      src:           'arriviMonselice_venezia',
      direzione:     'Venezia →',
      fonte:         'Monselice arrivi',
      binario:       t.binarioProgrammatoArrivoDescrizione ?? null,
      provvedimento: t.provvedimento ?? 0,
    });
  }

  // ── 3. ARRIVI A BOLOGNA da Venezia (treni che non fermano a Monselice) ──
  for (const t of arriviBologna) {
    if (!t?.numeroTreno) continue;
    const key = String(t.numeroTreno);
    if (mappa.has(key)) continue; // già rilevato a Monselice

    // Controlla che l'origine sia dalla parte di Venezia
    const orig = t.origine ?? t.compOrigineZeroEffettivo ?? '';
    const dir  = classificaDirezione(orig);
    if (dir !== 'venezia') continue;

    // ── Controllo transito Monselice ────────────────────────────────────────
    // Stima quando il treno avrebbe dovuto transitare a Monselice.
    // Monselice si trova ~35 min prima di Bologna sulla tratta.
    // Se quell'orario è già passato, il treno ha già attraversato il PL → ignora.
    const orario = t.orarioArrivo ?? t.orarioPartenza;
    if (orario) {
      const tsArrBologna  = parseInt(orario) + (t.ritardo ?? 0) * 60_000;
      const tsTransMons   = tsArrBologna - (CONFIG.minuti_PL_da_bologna - CONFIG.minuti_PL_da_monselice_nord) * 60_000;
      // tsTransMons è il momento stimato in cui il treno transitava a Monselice
      // Se è già passato (con margine di 2 min), il treno ha già superato il PL
      if (tsTransMons < Date.now() - 2 * 60_000) {
        console.log(`  ⏭  ${t.categoria ?? ''} ${t.numeroTreno} da Bologna: già transitato a Monselice (~${Math.round((Date.now()-tsTransMons)/60000)} min fa), ignorato`);
        continue;
      }
    }
    // ────────────────────────────────────────────────────────────────────────

    const eta = calcolaETA(t, 'arriviBologna_venezia');
    if (eta === null) continue;

    mappa.set(key, {
      numero:        t.numeroTreno,
      categoria:     t.categoria ?? 'R',
      destinazione:  t.destinazione ?? 'BOLOGNA C.LE',
      origine:       orig || '—',
      ritardo:       t.ritardo ?? 0,
      eta_min:       eta,
      src:           'arriviBologna_venezia',
      direzione:     'Venezia → Bologna',
      fonte:         'Bologna arrivi (passaggio)',
      binario:       null,
      provvedimento: t.provvedimento ?? 0,
    });
  }

  const treni = [...mappa.values()].sort((a, b) => a.eta_min - b.eta_min);
  const treniCircolanti = stat?.treniCircolanti ?? null;

  // Log riepilogo
  console.log(`  Treni rilevanti trovati: ${treni.length}`);
  treni.forEach(t =>
    console.log(`    ${t.categoria} ${String(t.numero).padStart(5)} | eta: ${String(t.eta_min).padStart(5)} min | ${t.fonte} | ${t.direzione} → ${t.destinazione}`)
  );

  return { treni, treniCircolanti };
}

// ─────────────────────────────────────────────
// CALCOLO STATO PL
// ─────────────────────────────────────────────
function calcolaStatoPL(treni, preChiusuraMin) {
  const trenoInTransito = treni.find(t => t.eta_min >= -2 && t.eta_min <= preChiusuraMin);
  const prossimo        = treni.find(t => t.eta_min > preChiusuraMin);
  return {
    stato:            trenoInTransito ? 'chiuso' : 'aperto',
    trenoInTransito:  trenoInTransito ?? null,
    prossimo:         prossimo ?? null,
    pre_chiusura_min: preChiusuraMin,
  };
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '.')));

app.get('/api/status', async (req, res) => {
  const preChiusura = Math.max(0, Math.min(15,
    parseFloat(req.query.pre_chiusura) || CONFIG.pre_chiusura_default
  ));
  try {
    if (!cacheValid()) {
      cache.data = await raccogliTreni();
      cache.ts   = Date.now();
    }
    const { treni, treniCircolanti } = cache.data;
    res.json({
      ok: true,
      timestamp:        new Date().toISOString(),
      cached:           cacheValid(),
      cache_age_sec:    Math.round((Date.now() - cache.ts) / 1000),
      treniCircolanti,
      ...calcolaStatoPL(treni, preChiusura),
      treni,
    });
  } catch (err) {
    console.error('[API ERROR]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/debug', (_req, res) => {
  res.json({ ok: true, log: apiLog });
});

app.get('/api/config', (_req, res) => {
  res.json({
    stazioni:                    CONFIG.stazioni,
    minuti_PL_da_monselice_nord: CONFIG.minuti_PL_da_monselice_nord,
    minuti_PL_arrivo_monselice:  CONFIG.minuti_PL_arrivo_monselice,
    minuti_PL_da_bologna:        CONFIG.minuti_PL_da_bologna,
    pre_chiusura_default:        CONFIG.pre_chiusura_default,
    whitelist_venezia:           CONFIG.WHITELIST_VENEZIA,
    blacklist_bologna:           CONFIG.BLACKLIST_BOLOGNA,
  });
});

// ─────────────────────────────────────────────
// AVVIO
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚦 Monitor PL — Battaglia Terme · Monselice`);
  console.log(`   Linea Venezia–Bologna`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Debug: http://localhost:${PORT}/api/debug\n`);
  console.log('   Logica direzioni:');
  console.log('   ✅ Partenze Monselice → Venezia/Padova    (PL +3 min)');
  console.log('   ✅ Arrivi  Monselice ← Venezia/Padova     (PL -5 min)');
  console.log('   ✅ Arrivi  Bologna   ← Venezia (passaggio)(PL -38 min)');
  console.log('   ❌ Partenze Monselice → Bologna/Mantova/Legnago (ignorati)\n');
});
