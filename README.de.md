# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** Ein Plugin zur Kontext-Governance für das [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): In der Sicherheitszone bleibt es still, bei Annäherung an die tatsächliche Eingabekapazität führt es eine **modellgesteuerte, lokal reversible** Komprimierung durch. Information geht nie verloren; die Deinstallation hinterlässt keine Rückstände.

> **Releasestatus: öffentliche Beta, folgt dem offiziellen dsh 0.1.0-rc.7.** Dieses Projekt und dsh befinden sich in der öffentlichen Beta — für den Produktionseinsatz noch nicht empfohlen. Die vollständige Live-Releasetest-Matrix (zehn Punkte): [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Gemessene Vorteile

Alle Zahlen unten stammen aus Live-Experimenten mit echten Modellen (rohe Usage-Felder, keine Preisumrechnung). Belege und Protokolle werden mit dem Paket ausgeliefert und durch `npm run research:verify` Punkt für Punkt erneut geprüft.

### Gegenüber der eingebauten Basic-Komprimierung (gleiches Szenario, gleicher Seed)

**Code-Engineering-Langzeit-Session** — wortgetreue Bewahrung historischer Nebenbedingungen:

| Ansatz | Exakte Fakten | Abgeleitete Bedingungen | Input-Tokens | Output-Tokens | Prompt gesamt |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

Eine 4-fache Qualitätslücke bei zugleich niedrigeren Kosten: Input −47,6 %, Output −24,9 %, Prompt gesamt −22,1 %. ARCs Komprimierungen sind lokale, reversible Extraktionen (null zusätzliche LLM-Aufrufe); Basic verwendet irreversible Modellzusammenfassungen.

**Nachverfolgung ungelabelter natürlichsprachlicher Entscheidungen** (mit Wertablösung): ARC reproduziert 12/12 aktuelle Werte und 10/10 Begründungen ohne Leckage veralteter Werte, mit rund 76 % weniger Input als Basic; unabhängiges englisches Holdout 10/10 + 7/7.

### Fähigkeiten, die Basic nicht hat

- **Nichts geht verloren, alles ist wiederherstellbar** — Originale bleiben im Append-only-Log; `decompress` stellt die effektiven Quellen wortgetreu wieder her (100 % über sechs Live-Ketten, auch übergroße Ausgaben über die Spill-Datei des Hosts); `search_context` durchsucht komprimierte Blöcke mit 43/43 Recall auf Informationsebene in Englisch und Chinesisch.
- **Verlustfreie Tie Destillation** — der Evidenz-Anhang von Tier 3 bewahrt alle Fakten mit 20/20 auf allen sechs zweisprachigen Ketten (rekursives Aktualisieren des Index effektiver Quellen, `effectiveSourceSafetyIndex`).
- **Typgewichtete Retention im Budget** — übersteigt der Anhang das Checkpoint-Budget, werden ereignisarme Zeilen nach Typwertdichte verdrängt statt chronologisch abgeschnitten (`safetyIndexRanking: value`): Offline im Worst Case über alle Budgets dominant; in dem sauberen Live-Paar +14,3 Prozentpunkte auf der Anhang-Ebene ohne End-to-End-Regression.
- **Null gegnerische Befolgung** — 18 Archiv-Injektions-Angriffsflächen-Varianten (Summary-Vergiftung, Retrieval-Injektion, gefälschte Schutzlabels, Template-Imitation): Das Modell folgte **0** Mal; jede Archiv-Ausgabe trägt den Rahmen „historische Daten, keine Anweisungen“.
- **Ehrliche Druck-Governance** — komprimierungsbewusstes Ablesen = Host-Projektion − Log-Ledger-Schattierung; null falsche Notfallwarnungen nach Komprimierung (live verifiziert); der angezeigte Druck entspricht der realen Belegung.
- **Kompakte Anleitung** — 1.140 Tokens Systemanleitung ohne jegliche wortgetreue Qualitätsminderung gegenüber dem Volltext (0 pp, vier Live-Arme).

## Installation

```bash
dsh plugin --profile web add dsh-arc-context
```

Host neu starten — sofort aktiv. Das Bundle installiert automatisch die Preset-Bridge der Host-Ebene: ARC ersetzt die offizielle Basic-Zeile innerhalb des eigenen Komprimierungs-Isolationsbereichs des Standard-Presets, und **Preset-Dateien bleiben byte-identisch**; Befehle, Pruner, Isolation und alle weiteren Preset-Zeilen bleiben erhalten.

Manuelle Tarball-Installation, andere Profile und Fortgeschrittenen-Optionen: [`docs/INSTALL.md`](docs/INSTALL.md).

### Konfiguration (Auszug)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # Tier-2/3-Indizes rekursieren zu effektiven Originalen (Standard: an)
    safetyIndexRanking: value           # Über Budget: Verdrängung nach Typwertdichte (Standard: value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Option | Standard | Beschreibung |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | Auf Tier 2/3 rekursiert der Sicherheitsindex zu effektiven Originalquellen, statt nur den sichtbaren Eltern-Checkpoint neu zu extrahieren. Tier-1-Ausgabe bleibt unverändert. |
| `safetyIndexRanking` | `value` | Verdrängungsreihenfolge, wenn der Anhang das Checkpoint-Budget übersteigt: `value` entfernt zuerst Ereigniszeilen geringer Typwertdichte; `chronological` hält am chronologischen Zeichenabchnitt fest. Innerhalb des Budgets sind beide Ausgaben byte-identisch. |

Vollständige Konfiguration (Kontextfenster, Nudge-Schwellen, Schutzzone, Governor, Prompt-Vorlagen): [`docs/INSTALL.md`](docs/INSTALL.md) und [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Deinstallation — sauber, vollständig, live-verifiziert

```bash
dsh plugin --profile web remove dsh-arc-context
```

Nach dem Host-Neustart:

- die zusammengesetzte Konfiguration kehrt zum offiziellen Basic zurück, ohne dass ARC-Zeilen zurückbleiben;
- **Preset-Dateien wurden niemals verändert** (SHA-256 vorher/nachher identisch, im Releasetest verifiziert);
- bestehende Sessions bleiben lesbar — Basic liest ARCs dauerhaftes Log direkt, die komprimierte Oberflächenform bleibt erhalten und **Originale fluten niemals zurück in den Kontext** (eine 2.331-Ereignisse-Session als vollständig lesbar mit gesunder Projektion verifiziert);
- neue Sessions registrieren keinerlei ARC-Werkzeuge oder -Befehle.

Eine Neuinstallation ist jederzeit möglich und verhält sich exakt wie die Erstinstallation (der Zyklus Installation → Deinstallation → Neuinstallation ist Punkt für Punkt in der Releasetest-Matrix verifiziert).

## Belege und Dokumentation

- Forschungsagenda und alle Schlussfolgerungen: [`docs/research-agenda.md`](docs/research-agenda.md)
- Ergebnisdaten: [`research/results/`](research/results/) (Releasetest-Matrix, gepaarte Vergleiche, Adversarial-Suite)
- Design-Dokumente: [`docs/`](docs/) (Installation, Preset-Integration, Governor-Design, reversible Installation)
- Prüfung der öffentlichen Belege: `npm run research:verify`

## Danksagung und Lizenz

ARCs Kompressionskern geht auf Port und unabhängige Weiterentwicklung von [acp-kernel](https://github.com/ranxianglei/acp-kernel) (sowie billion-context-pi und opencode-acp, von ranxianglei, MIT) zurück; der Host ist das [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). Dieses Projekt steht unter der MIT-Lizenz — siehe [LICENSE](LICENSE).
