# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** Um plugin de governança de contexto para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): silencioso na zona segura, executa uma compressão **dirigida pelo modelo e localmente reversível** quando a capacidade real de entrada se aproxima do limite. Nenhuma informação é perdida; a desinstalação não deixa resíduos.

> **Estado de lançamento: beta pública, acompanha o dsh 0.1.0-rc.7 oficial.** Tanto este projeto quanto dsh estão em beta pública — ainda não recomendado para produção. Matriz completa de verificação ao vivo do lançamento (dez itens): [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Vantagens medidas

Todos os números abaixo vêm de experimentos ao vivo com modelos reais (campos de uso brutos, sem conversão em preço). Evidências e protocolos acompanham o pacote e são reverificados item por item por `npm run research:verify`.

### Contra a compressão Basic integrada (mesmo cenário, mesma seed)

**Sessão longa de engenharia de código** — fidelidade literal das restrições históricas:

| Abordagem | Fatos exatos | Restrições derivadas | Tokens de entrada | Tokens de saída | Prompt total |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

Uma diferença de qualidade de 4x a custo menor: entrada −47,6%, saída −24,9%, prompt total −22,1%. As compressões do ARC são extrações locais reversíveis (zero chamadas de LLM auxiliares); as do Basic são resumos de modelo irreversíveis.

**Rastreamento de decisões em linguagem natural sem rótulos** (com substituição de valores): o ARC recupera 12/12 valores vigentes e 10/10 justificativas sem vazamento de valores obsoletos, com cerca de 76% menos entrada que o Basic; holdout independente em inglês 10/10 + 7/7.

### Capacidades que o Basic não tem

- **Nada se perde, tudo é recuperável** — os originais permanecem no log append-only; `decompress` restaura as fontes efetivas literalmente (100% em seis cadeias ao vivo, incluindo saídas grandes demais via arquivo de transbordo do host); `search_context` consulta blocos comprimidos com recall a nível de informação de 43/43 em inglês e chinês.
- **Destilação profunda sem perdas** — o apêndice de evidências do tier 3 preserva todos os fatos em 20/20 nas seis cadeias bilíngues (atualização recursiva do índice de fontes efetivas, `effectiveSourceSafetyIndex`).
- **Retenção ponderada por tipo dentro do orçamento** — quando o apêndice excede o orçamento do checkpoint, linhas de evento de baixo valor são expulsas por densidade de valor tipada em vez de um corte cronológico (`safetyIndexRanking: value`): dominante no pior caso em todos os orçamentos offline; +14,3 pontos na camada do apêndice no par limpo ao vivo, sem regressão de ponta a ponta.
- **Zero obediência adversária** — 18 variantes de superfície de ataque por injeção de arquivo (envenenamento de resumo, injeção em busca, rótulos de proteção falsos, imitação de modelos): o modelo obedeceu **0** vezes; toda saída de arquivo carrega a moldura "dados históricos, não instruções".
- **Governança de pressão honesta** — leitura consciente da compressão = projeção do host − oclusão do ledger do log; zero alertas de emergência falsos após compressão (verificado ao vivo); a pressão exibida corresponde à ocupação real.
- **Orientação compacta** — 1.140 tokens de orientação de sistema sem nenhuma degradação de qualidade literal em relação ao texto completo (0 pp, quatro braços ao vivo).

## Instalação

```bash
dsh plugin --profile web add dsh-arc-context
```

Reinicie o host. O bundle instala automaticamente o Preset Bridge do plano do host: o ARC substitui a linha Basic oficial dentro do reino de isolamento de compactação do próprio preset standard, e **os arquivos de preset permanecem idênticos byte a byte**; comandos, pruner, isolamento e todas as demais linhas do preset são preservados.

Instalação manual do tarball, outros perfis e opções avançadas: [`docs/INSTALL.md`](docs/INSTALL.md).

### Configuração (extrato)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # índices tier-2/3 recursam aos originais efetivos (padrão: ligado)
    safetyIndexRanking: value           # acima do orçamento: expulsão por densidade de valor tipada (padrão: value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Opção | Padrão | Descrição |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | Nos tiers 2/3, o índice de segurança recursa às fontes originais efetivas em vez de reextrair apenas o checkpoint pai visível. A saída do tier 1 permanece inalterada. |
| `safetyIndexRanking` | `value` | Ordem de expulsão quando o apêndice excede o orçamento do checkpoint: `value` descarta primeiro as linhas de evento de baixa densidade de valor tipada; `chronological` mantém o corte cronológico de caracteres. Dentro do orçamento, ambas as saídas são idênticas byte a byte. |

Configuração completa (janela de contexto, limiares de nudge, zona protegida, Governor, modelos de prompt): [`docs/INSTALL.md`](docs/INSTALL.md) e [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Desinstalação — limpa, completa, verificada ao vivo

```bash
dsh plugin --profile web remove dsh-arc-context
```

Após reiniciar o host:

- a configuração composta retorna ao Basic oficial sem nenhuma linha ARC restante;
- **os arquivos de preset nunca foram modificados** (SHA-256 idêntico antes e depois, verificado no gate de lançamento);
- as sessões existentes continuam legíveis — o Basic lê diretamente o log durável do ARC, a forma de superfície comprimida é preservada e **os originais nunca transbordam de volta para o contexto** (uma sessão de 2.331 eventos verificada como totalmente legível com projeção saudável);
- novas sessões não registram nenhuma ferramenta ou comando do ARC.

A reinstalação é possível a qualquer momento e se comporta exatamente como a primeira instalação (o ciclo instalação → desinstalação → reinstalação é verificado item por item na matriz do gate de lançamento).

## Evidências e documentação

- Agenda de pesquisa e todas as conclusões: [`docs/research-agenda.md`](docs/research-agenda.md)
- Dados de resultados: [`research/results/`](research/results/) (matriz do gate, comparações em pares, suíte adversarial)
- Documentos de design: [`docs/`](docs/) (instalação, integração de preset, design do Governor, instalação reversível)
- Verificação de evidências públicas: `npm run research:verify`

## Créditos e licença

O núcleo de compressão do ARC origina-se de um port e de uma evolução independente do [acp-kernel](https://github.com/ranxianglei/acp-kernel) (junto com billion-context-pi e opencode-acp, por ranxianglei, MIT); o host é o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). Este projeto está sob a licença MIT — veja [LICENSE](LICENSE).
