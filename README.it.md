# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** Un plugin di governance del contesto per il [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): silenzioso nella zona di sicurezza, esegue una compressione **guidata dal modello e localmente reversibile** quando la capacità di ingresso reale si avvicina. Nessuna informazione va persa; la disinstallazione non lascia residui.

> **Stato di rilascio: beta pubblica, segue l'ufficiale dsh 0.1.0-rc.8.** Sia questo progetto che dsh sono in beta pubblica — non ancora consigliato per la produzione. Matrice completa di verifica live del rilascio (dieci punti): [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Vantaggi misurati

Tutti i numeri seguenti provengono da esperimenti live con modelli reali (campi d'uso grezzi, nessuna conversione in prezzo). Evidenze e protocolli sono inclusi nel pacchetto e riverificati punto per punto da `npm run research:verify`.

### Contro la compressione Basic integrata (stesso scenario, stesso seed)

**Sessione lunga di ingegneria del codice** — fedeltà verbatim dei vincoli storici:

| Approccio | Fatti esatti | Vincoli derivati | Token di input | Token di output | Prompt totale |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

Un divario di qualità di 4 volte a costo inferiore: input −47,6%, output −24,9%, prompt totale −22,1%. Le compressioni di ARC sono estrazioni locali reversibili (zero chiamate LLM ausiliarie); quelle di Basic sono riassunti di modello irreversibili.

**Tracciamento decisionale in linguaggio naturale senza etichette** (con sostituzione di valori): ARC richiama 12/12 valori correnti e 10/10 motivazioni senza perdite di valori obsoleti, con circa il 76% di input in meno rispetto a Basic; holdout inglese indipendente 10/10 + 7/7.

### Capacità che Basic non ha

- **Nulla si perde, tutto è recuperabile** — gli originali restano nel log append-only; `decompress` ripristina le sorgenti effettive verbatim (100% su sei catene live, inclusi gli output oversized tramite il file di spill dell'host); `search_context` interroga i blocchi compressi con richiamo a livello informativo 43/43 in inglese e cinese.
- **Distillazione profonda senza perdita** — l'appendice di evidenze del tier 3 conserva tutti i fatti a 20/20 su tutte e sei le catene bilingue (aggiornamento ricorsivo dell'indice delle sorgenti effettive, `effectiveSourceSafetyIndex`).
- **Ritenzione pesata per tipo nel budget** — quando l'appendice supera il budget del checkpoint, le righe di evento a basso valore vengono espulse per densità di valore tipizzata anziché con un taglio cronologico (`safetyIndexRanking: value`): dominante nel caso peggiore a ogni budget offline; +14,3 punti sulla scala appendice nella coppia live pulita, senza regressioni end-to-end.
- **Zero obbedienza avversariale** — 18 varianti di superficie d'attacco a iniezione d'archivio (avvelenamento del riassunto, iniezione nel retrieval, falsi tag di protezione, imitazione di template): il modello ha obbedito **0** volte; ogni output d'archivio porta l'inquadratura «dati storici, non istruzioni».
- **Governance della pressione onesta** — lettura consapevole della compressione = proiezione host − occultamento del registro; zero falsi allarmi d'emergenza dopo la compressione (verificato live); la pressione mostrata coincide con l'occupazione reale.
- **Guida compatta** — 1.140 token di guida di sistema senza alcuna degradazione della qualità verbatim rispetto al testo completo (0 pp, quattro bracci live).

## Installazione

```bash
dsh plugin --profile web add dsh-arc-context
```

Riavviare l'host. Il bundle installa automaticamente il Preset Bridge del piano host: ARC sostituisce la riga Basic ufficiale dentro il realm di isolamento della compressione del preset standard stesso, e **i file del preset restano identici al byte**; comandi, pruner, isolamento e ogni altra riga del preset sono preservati.

Installazione manuale del tarball, altri profili e opzioni avanzate: [`docs/INSTALL.md`](docs/INSTALL.md).

### Configurazione (estratto)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # gli indici tier-2/3 risalgono ricorsivamente agli originali (predefinito: on)
    safetyIndexRanking: value           # oltre budget: espulsione per densità di valore tipizzata (predefinito: value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Opzione | Predefinito | Descrizione |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | Ai tier 2/3 l'indice di sicurezza risale ricorsivamente alle sorgenti originali effettive invece di riestrarre solo il checkpoint padre visibile. L'output del tier 1 è invariato. |
| `safetyIndexRanking` | `value` | Ordine di espulsione quando l'appendice supera il budget del checkpoint: `value` elimina prima le righe di evento a bassa densità di valore tipizzata; `chronological` mantiene il taglio cronologico dei caratteri. Entro il budget le due uscite sono byte-identiche. |

Configurazione completa (finestra di contesto, soglie di nudge, zona protetta, Governor, template dei prompt): [`docs/INSTALL.md`](docs/INSTALL.md) e [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Disinstallazione — pulita, completa, verificata live

```bash
dsh plugin --profile web remove dsh-arc-context
```

Dopo il riavvio dell'host:

- la configurazione composta torna al Basic ufficiale senza alcuna riga ARC residua;
- **i file del preset non sono mai stati modificati** (SHA-256 identico prima e dopo, verificato nel gate di rilascio);
- le sessioni esistenti restano leggibili — Basic legge direttamente il log durevole di ARC, la forma di superficie compressa è conservata e **gli originali mai rifluiscono nel contesto** (una sessione di 2.331 eventi verificata interamente leggibile con proiezione sana);
- le nuove sessioni non registrano alcuno strumento o comando ARC.

La reinstallazione è possibile in ogni momento e si comporta esattamente come la prima installazione (il ciclo installazione → disinstallazione → reinstallazione è verificato punto per punto nella matrice del gate di rilascio).

## Evidenze e documentazione

- Agenda di ricerca e tutte le conclusioni: [`docs/research-agenda.md`](docs/research-agenda.md)
- Dati dei risultati: [`research/results/`](research/results/) (matrice del gate, confronti appaiati, suite avversariale)
- Documenti di progettazione: [`docs/`](docs/) (installazione, integrazione preset, design del Governor, installazione reversibile)
- Verifica delle evidenze pubbliche: `npm run research:verify`

## Riconoscimenti e licenza

Il nucleo di compressione di ARC deriva da un port e da un'evoluzione indipendente di [acp-kernel](https://github.com/ranxianglei/acp-kernel) (con billion-context-pi e opencode-acp, di ranxianglei, MIT); l'host è il [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). Questo progetto è sotto licenza MIT — vedi [LICENSE](LICENSE).
