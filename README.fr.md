# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** Un plugin de gouvernance du contexte pour [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) : silencieux en zone sûre, il effectue une compression **pilotée par le modèle et réversible localement** à l'approche de la capacité d'entrée réelle. Aucune information n'est perdue ; la désinstallation ne laisse aucune trace.

> **État de publication : 0.2.0-beta.12, suit la version officielle 0.1.0-rc.7.** Ce projet comme l'hôte sont en bêta publique — usage en production déconseillé pour l'instant. Matrice complète de vérification en conditions réelles (dix éléments) : [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Avantages mesurés

Tous les chiffres ci-dessous proviennent d'expériences en conditions réelles avec de vrais modèles (champs d'usage bruts, sans conversion monétaire). Les preuves et protocoles sont livrés avec le paquet et revérifiés par `npm run research:verify`.

### Face à la compression Basic intégrée (même scénario, même graine)

**Session longue d'ingénierie logicielle** — fidélité verbatim des contraintes historiques :

| Approche | Faits exacts | Contraintes dérivées | Tokens d'entrée | Tokens de sortie | Prompt total |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

Un écart de qualité de 4x à coût inférieur : entrée −47,6 %, sortie −24,9 %, prompt total −22,1 %. Les compressions d'ARC sont des extractions locales réversibles (zéro appel LLM auxiliaire) ; celles de Basic sont des résumés de modèle irréversibles.

**Suivi décisionnel en langage naturel sans étiquettes** (avec remplacement de valeurs) : ARC restitue 12/12 valeurs courantes et 10/10 justifications, sans fuite de valeurs obsolètes, avec environ 76 % d'entrée en moins que Basic ; holdout anglais indépendant 10/10 + 7/7.

### Des capacités que Basic n'a pas

- **Rien ne se perd, tout se récupère** — les originaux restent dans le journal append-only ; `decompress` restaure les sources effectives verbatim (100 % sur six chaînes réelles, y compris les sorties surdimensionnées via le fichier de débordement de l'hôte) ; `search_context` interroge les blocs compressés avec un rappel de niveau informationnel de 43/43 en anglais comme en chinois.
- **Distillation profonde sans perte** — l'annexe de preuves de tier 3 conserve tous les faits à 20/20 sur les six chaînes bilingues (rafraîchissement récursif de l'index des sources effectives, `effectiveSourceSafetyIndex`).
- **Rétention pondérée par type sous budget** — lorsque l'annexe dépasse le budget du point de contrôle, les lignes d'événements de faible valeur sont évincées par densité de valeur typée plutôt que par une coupe chronologique (`safetyIndexRanking: value`) : domination sur le pire cas à tous les budgets hors ligne ; +14,3 pp sur la couche annexe dans la paire live propre, sans régression de bout en bout.
- **Zéro obéissance adverse** — 18 variantes de surfaces d'attaque par injection d'archives (empoisonnement de résumé, injection dans la recherche, fausses étiquettes de protection, imitation de modèle…) : le modèle a obéi **0** fois ; toute sortie d'archive porte le cadre « données historiques, pas des instructions ».
- **Gouvernance de pression honnête** — lecture sensible à la compression = projection hôte − Occultation du registre du journal ; zéro fausse alerte d'urgence après compression (vérifié en live) ; la pression affichée correspond à l'occupation réelle.
- **Guidance compacte** — 1 140 tokens de guidance système sans aucune dégradation de qualité verbatim par rapport au texte complet (0 pp, quatre bras live).

## Installation

```bash
dsh plugin --profile web add dsh-arc-context
```

Redémarrez l'hôte. Le bundle installe automatiquement le Preset Bridge du plan hôte : ARC remplace la ligne Basic officielle au sein du royaume d'isolation de compression du preset standard lui-même, et **les fichiers de preset restent identiques à l'octet près** ; commandes, élagueur, isolation et toutes les autres lignes du preset sont préservées.

Installation manuelle du tarball, autres profils et options avancées : [`docs/INSTALL.md`](docs/INSTALL.md).

### Configuration (extrait)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # les index tier-2/3 remontent récursivement aux originaux (activé par défaut)
    safetyIndexRanking: value           # éviction par densité de valeur typée au-delà du budget (value par défaut)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Option | Défaut | Description |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | Aux tiers 2/3, l'index de sécurité remonte récursivement aux sources originales effectives au lieu de réextraire seulement le point de contrôle parent visible. La sortie de tier 1 est inchangée. |
| `safetyIndexRanking` | `value` | Ordre d'éviction lorsque l'annexe dépasse le budget du point de contrôle : `value` exclut d'abord les lignes d'événements de faible valeur par densité de valeur typée ; `chronological` conserve la coupe chronologique historique. Sous le budget, les deux sorties sont identiques à l'octet près. |

Configuration complète (fenêtre de contexte, seuils de nudge, zone protégée, Governor, gabarits d'invites) : [`docs/INSTALL.md`](docs/INSTALL.md) et [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Désinstallation — propre, complète, vérifiée en conditions réelles

```bash
dsh plugin --profile web remove dsh-arc-context
```

Après redémarrage de l'hôte :

- la configuration composée revient au Basic officiel sans aucune ligne ARC résiduelle ;
- **les fichiers de preset n'ont jamais été modifiés** (SHA-256 identique avant et après, vérifié au portail de publication) ;
- les sessions existantes restent lisibles — Basic lit directement le journal durable d'ARC, la forme de surface compressée est conservée et **les originaux ne refluent jamais dans le contexte** (une session de 2 331 événements vérifiée entièrement lisible avec une projection saine) ;
- les nouvelles sessions n'enregistrent aucun outil ni commande ARC.

La réinstallation est possible à tout moment et se comporte exactement comme la première installation (le cycle installation → désinstallation → réinstallation est vérifié point par point dans la matrice du portail de publication).

## Preuves et documentation

- Agenda de recherche et conclusions : [`docs/research-agenda.md`](docs/research-agenda.md)
- Données de résultats : [`research/results/`](research/results/) (matrice du portail, comparaisons appariées, suite adverse)
- Documents de conception : [`docs/`](docs/) (installation, intégration preset, conception du Governor, installation réversible)
- Vérification des preuves publiques : `npm run research:verify`

## Crédits et licence

Le cœur de compression d'ARC provient d'un portage et d'une évolution indépendante d'[acp-kernel](https://github.com/ranxianglei/acp-kernel) (avec billion-context-pi et opencode-acp, par ranxianglei, MIT) ; l'hôte est le [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). Ce projet est sous licence MIT — voir [LICENSE](LICENSE).
