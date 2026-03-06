# 🚦 Monitor Passaggio a Livello — Battaglia Terme · Monselice
**Linea Venezia–Bologna**

Applicazione web che stima in tempo reale lo stato del passaggio a livello
tra Battaglia Terme e Monselice, basandosi sui dati dell'API pubblica di Trenitalia (ViaggiaTreno).

---

## Avvio rapido

Assicurati di avere **Node.js** installato (versione 16+), poi:

```bash
# Installa le dipendenze (solo la prima volta)
npm install

# Avvia il server
node server.js

# Oppure con auto-reload (richiede Node.js 18+)
npm run dev
```

Poi apri il browser su **http://localhost:3000**

---

## Funzionalità

- **Semaforo visivo** APERTO / CHIUSO con glow animato
- **Slider anticipazione chiusura** — imposta quanti minuti prima del treno
  considerare il PL chiuso (da 0 a 10 minuti, step 0.5)
- **Lista treni in tempo reale** con ETA al passaggio a livello, ritardo, direzione e binario
- **Timeline chiusure previste** nella prossima ora con orario stimato di chiusura e transito
- **Mappa canvas** con posizione stimata di ogni treno sulla tratta
- **Auto-aggiornamento** ogni 25 secondi
- **Cache lato server** (20s) per non sovraccaricare l'API Trenitalia

---

## Architettura

```
pl-monitor/
├── server.js         ← Backend Express (proxy API + cache + logica PL)
├── public/
│   └── index.html    ← Frontend (HTML/CSS/JS in un file solo)
└── package.json
```

Il server fa da proxy verso l'API di ViaggiaTreno, evitando problemi di CORS
e aggiungendo un layer di cache in memoria.

### Endpoint API server

| Metodo | Path | Descrizione |
|--------|------|-------------|
| GET | `/api/status?pre_chiusura=2` | Stato PL + lista treni |
| GET | `/api/config` | Configurazione tratta |

---

## Limiti noti

- I treni **a lunga percorrenza che non fermano** a Battaglia o Monselice
  (es. alcuni Intercity e Frecciarossa sulla Venezia–Bologna) potrebbero non
  essere rilevati dall'API `/partenze` e `/arrivi`
- La **posizione del treno** tra le stazioni è stimata dall'orario teorico + ritardo,
  non è un dato GPS in tempo reale
- L'API di ViaggiaTreno è **non ufficiale** e potrebbe cambiare senza preavviso

---

## Configurazione

Nel file `server.js` puoi modificare:

```js
const CONFIG = {
  minuti_da_monselice: 3,  // minuti di percorrenza dal PL a Monselice
  minuti_da_battaglia: 5,  // minuti di percorrenza dal PL a Battaglia
  pre_chiusura_default: 2, // valore default dello slider
};
```

---

⚠️ **Questo strumento è puramente indicativo e non sostituisce i segnali
ufficiali del passaggio a livello.**
