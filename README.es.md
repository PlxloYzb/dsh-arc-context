# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** Un plugin de gobernanza de contexto para el [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): silencioso en la zona segura, ejecuta una compresión **dirigida por el modelo y localmente reversible** cuando se acerca la capacidad real de entrada. La información nunca se pierde; la desinstalación no deja residuos.

> **Estado de lanzamiento: beta pública, sigue el dsh 0.1.0-rc.8 oficial.** Tanto este proyecto como dsh están en beta pública — aún no se recomienda para producción. Matriz completa de verificación en vivo del lanzamiento (diez puntos): [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## Ventajas medidas

Todos los números siguientes provienen de experimentos en vivo con modelos reales (campos de uso sin procesar, sin conversión de precio). Las evidencias y los protocolos se distribuyen con el paquete y se reverifican punto por punto con `npm run research:verify`.

### Frente a la compresión Basic integrada (mismo escenario, misma semilla)

**Sesión larga de ingeniería de código** — fidelidad literal de las restricciones históricas:

| Enfoque | Hechos exactos | Restricciones derivadas | Tokens de entrada | Tokens de salida | Prompt total |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

Una brecha de calidad de 4x a menor coste: entrada −47,6 %, salida −24,9 %, prompt total −22,1 %. Las compresiones de ARC son extracciones locales reversibles (cero llamadas LLM auxiliares); las de Basic son resúmenes de modelo irreversibles.

**Seguimiento de decisiones en lenguaje natural sin etiquetas** (con sustitución de valores): ARC recupera 12/12 valores vigentes y 10/10 fundamentos sin fugas de valores obsoletos, con cerca de un 76 % menos de entrada que Basic; holdout independiente en inglés 10/10 + 7/7.

### Capacidades que Basic no tiene

- **Nada se pierde, todo es recuperable** — los originales permanecen en el registro append-only; `decompress` restaura las fuentes efectivas literalmente (100 % en seis cadenas en vivo, incluidas las salidas sobredimensionadas vía el archivo de desbordamiento del host); `search_context` consulta los bloques comprimidos con un recuerdo a nivel de información de 43/43 en inglés y chino.
- **Destilación profunda sin pérdida** — el apéndice de evidencias del tier 3 conserva todos los hechos en 20/20 en las seis cadenas bilingües (actualización recursiva del índice de fuentes efectivas, `effectiveSourceSafetyIndex`).
- **Retención ponderada por tipo dentro del presupuesto** — cuando el apéndice supera el presupuesto del checkpoint, las líneas de evento de bajo valor se expulsan por densidad de valor tipificada en lugar de un corte cronológico (`safetyIndexRanking: value`): dominante en el peor caso en todos los presupuestos offline; +14,3 puntos en la capa del apéndice en el par limpio en vivo, sin regresión de extremo a extremo.
- **Cero obediencia adversarial** — 18 variantes de superficie de ataque por inyección de archivo (envenenamiento de resumen, inyección en búsqueda, etiquetas de protección falsas, imitación de plantillas): el modelo obedeció **0** veces; toda salida de archivo lleva el marco «datos históricos, no instrucciones».
- **Gobernanza de presión honesta** — lectura consciente de la compresión = proyección del host − ocultación del libro de registro; cero avisos de emergencia falsos tras la compresión (verificado en vivo); la presión mostrada coincide con la ocupación real.
- **Guía compacta** — 1.140 tokens de guía del sistema sin ninguna degradación de calidad literal frente al texto completo (0 pp, cuatro brazos en vivo).

## Instalación

```bash
dsh plugin --profile web add dsh-arc-context
```

Reinicia el host. El bundle instala automáticamente el Preset Bridge del plano del host: ARC sustituye la línea Basic oficial dentro del reino de aislamiento de compactación del propio preset estándar, y **los archivos del preset permanecen idénticos byte a byte**; comandos, pruner, aislamiento y cualquier otra línea del preset se conservan.

Instalación manual del tarball, otros perfiles y opciones avanzadas: [`docs/INSTALL.md`](docs/INSTALL.md).

### Configuración (extracto)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # los índices tier-2/3 recurse a los originales efectivos (por defecto: on)
    safetyIndexRanking: value           # sobre presupuesto: expulsión por densidad de valor tipificada (por defecto: value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| Opción | Por defecto | Descripción |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | En los tiers 2/3, el índice de seguridad recurse a las fuentes originales efectivas en lugar de reextraer solo el checkpoint padre visible. La salida del tier 1 no cambia. |
| `safetyIndexRanking` | `value` | Orden de expulsión cuando el apéndice supera el presupuesto del checkpoint: `value` descarta primero las líneas de evento de baja densidad de valor tipificada; `chronological` mantiene el corte cronológico de caracteres. Dentro del presupuesto ambas salidas son idénticas byte a byte. |

Configuración completa (ventana de contexto, umbrales de nudge, zona protegida, Governor, plantillas de prompts): [`docs/INSTALL.md`](docs/INSTALL.md) y [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## Desinstalación — limpia, completa, verificada en vivo

```bash
dsh plugin --profile web remove dsh-arc-context
```

Tras reiniciar el host:

- la configuración compuesta vuelve al Basic oficial sin ninguna línea ARC residual;
- **los archivos del preset nunca se modificaron** (SHA-256 idéntico antes y después, verificado en la puerta de lanzamiento);
- las sesiones existentes siguen siendo legibles — Basic lee directamente el registro duradero de ARC, la forma de superficie comprimida se conserva y **los originales nunca refluyen al contexto** (una sesión de 2.331 eventos verificada como totalmente legible con proyección sana);
- las sesiones nuevas no registran ninguna herramienta ni comando de ARC.

La reinstalación es posible en cualquier momento y se comporta exactamente igual que la primera instalación (el ciclo instalación → desinstalación → reinstalación está verificado punto por punto en la matriz de la puerta de lanzamiento).

## Evidencias y documentación

- Agenda de investigación y todas las conclusiones: [`docs/research-agenda.md`](docs/research-agenda.md)
- Datos de resultados: [`research/results/`](research/results/) (matriz de la puerta, comparaciones emparejadas, suite adversarial)
- Documentos de diseño: [`docs/`](docs/) (instalación, integración de presets, diseño del Governor, instalación reversible)
- Verificación de evidencias públicas: `npm run research:verify`

## Créditos y licencia

El núcleo de compresión de ARC procede de un port y una evolución independiente de [acp-kernel](https://github.com/ranxianglei/acp-kernel) (con billion-context-pi y opencode-acp, de ranxianglei, MIT); el host es el [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek AI). Este proyecto está bajo licencia MIT — ver [LICENSE](LICENSE).
