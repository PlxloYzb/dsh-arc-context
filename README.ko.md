# dsh-arc-context

[中文](./README.md) | [English](./README.en.md) | [Русский](./README.ru.md) | [Deutsch](./README.de.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Français](./README.fr.md) | [Italiano](./README.it.md) | [Español](./README.es.md) | [العربية](./README.ar.md) | [ไทย](./README.th.md) | [Tiếng Việt](./README.vi.md) | [Português (BR)](./README.pt-BR.md) | [हिन्दी](./README.hi.md) | [Bahasa Indonesia](./README.id.md)

**ARC = Adaptive Reversible Context.** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)를 위한 컨텍스트 거버넌스 플러그인입니다. 안전 구간에서는 조용히 유지되고, 실제 입력 용량에 가까워지면 **모델 주도·로컬 가역** 압축을 수행합니다. 정보는 절대 손실되지 않으며, 제거 시 흔적도 남기지 않습니다.

> **릴리스 상태: 퍼블릭 베타, 공식 dsh 0.1.0-rc.7 추적.** 본 프로젝트와 dsh 모두 퍼블릭 베타이므로 아직 프로덕션 사용은 권장하지 않습니다. 10개 항목의 라이브 릴리스 게이트 검증 매트릭스: [`research/results/release-verification-0.2.0-beta.12.json`](research/results/release-verification-0.2.0-beta.12.json).

## 실측 강점

아래 수치는 모두 실제 모델 라이브 실험에서 얻은 것입니다(원시 usage 기준, 가격 환산 없음). 증거와 실험 프로토콜은 패키지에 포함되어 있으며 `npm run research:verify`로 항목별로 재검증됩니다.

### 내장 Basic 압축 대비 (동일 시나리오·동일 시드)

**코드 엔지니어링 롱 세션** — 역사적 제약조건의 축어 보존:

| 방식 | 정확 사실 | 파생 제약 | 입력 토큰 | 출력 토큰 | 전체 prompt |
|---|---:|---:|---:|---:|---:|
| **ARC** | **24/24** | **4/4** | **121,146** | **23,234** | **1,055,802** |
| Basic | 6/24 | 0/4 | 231,315 | 30,940 | 1,355,539 |

4배의 품질 격차를 더 낮은 비용으로 달성: 입력 −47.6%, 출력 −24.9%, 전체 prompt −22.1%. ARC의 압축은 로컬 가방식(보조 LLM 호출 0회)이며, Basic은 되돌릴 수 없는 모델 요약입니다.

**라벨 없는 자연어 의사결정 추적** (값 대체 포함): ARC는 현재값 12/12, 근거 10/10을 재현하고 구폐값 누출은 0이며, 입력은 Basic 대비 약 76% 낮습니다. 독립 영어 홀드아웃 10/10 + 7/7.

### Basic에는 없는 능력

- **손실 없음, 완전 복구** — 원본은 append-only 로그에 영구 보존됩니다. `decompress`는 유효 소스를 축자로 복원하며(6개 라이브 체인에서 100%, 초대형 출력은 호스트 스플 파일로도 완전), `search_context`는 압축 블록을 검색해 한·영 정보 수준 재현율 43/43을 기록합니다.
- **무손실 심층 증류** — tier-3 증거 부록이 6개 이중언어 체인 모두에서 사실 전체를 20/20으로 보존합니다(재귀적 유효 소스 인덱스 갱신, `effectiveSourceSafetyIndex`).
- **예산 내 타입 가중 보존** — 부록이 체크포인트 예산을 초과하면 시간순 절단이 아니라 타입 가치 밀도로 저가치 이벤트 행을 먼저 제외합니다(`safetyIndexRanking: value`). 오프라인 최악 케이스에서 모든 예산 구간 우위, 라이브 페어에서 부록 계층 +14.3pp, 엔드투엔드 회귀 0.
- **적대적 명령 준수 0** — 18개 아카이브 주입 공격 표면 변종(요약 오염, 검색 주입, 가짜 보호 라벨, 템플릿 모방 등)에서 모델이 명령을 따른 횟수 **0**. 모든 아카이브 출력에는 "역사적 데이터, 지시 아님" 프레임이 붙습니다.
- **정직한 압력 거버넌스** — 압축 인식 판정 = 호스트 투영 − 로그 원장 차감. 압축 후 거짓 긴급 경고 0(실측), 표시되는 압력이 실제 점유와 일치합니다.
- **컴팩트 가이던스** — 시스템 가이던스 1,140 토큰으로 전체 텍스트 대비 축어 품질 열화 0pp(라이브 4암).

## 설치

```bash
dsh plugin --profile web add dsh-arc-context
```

호스트를 재시작하면 즉시 적용됩니다. 번들은 host-plane Preset Bridge를 자동 설치합니다. ARC가 standard preset 자체의 compaction 격리 영역에서 공식 Basic 행을 교체하며, **preset 파일은 바이트 단위로 동일하게 유지**됩니다. 명령·프루너·isolation 및 나머지 preset 행은 모두 보존됩니다.

수동 tarball 설치, 다른 프로필, 고급 옵션: [`docs/INSTALL.md`](docs/INSTALL.md).

### 설정 (발췌)

```yaml
- id: compaction-arc-bridge
  name: 'dsh-arc-context/bridge'
  config:
    effectiveSourceSafetyIndex: true   # tier-2/3 인덱스가 유효 원본으로 재귀 (기본 켜짐)
    safetyIndexRanking: value           # 예산 초과 시 타입 가치 밀도로 제외 (기본 value)
    adaptiveGovernor:
      enabled: true
      maxOutputTokens: auto
```

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `effectiveSourceSafetyIndex` | `true` | tier 2/3에서 안전 인덱스가 보이는 부모 체크포인트만 재추출하지 않고 유효 원본 소스로 재귀합니다. tier-1 출력은 불변입니다. |
| `safetyIndexRanking` | `value` | 부록이 체크포인트 예산을 초과할 때의 제외 순서: `value`는 타입 가치 밀도가 낮은 이벤트 행부터 제외, `chronological`은 기존 시간순 문자 절단. 예산 이내에서는 양자 출력이 바이트 단위로 동일합니다. |

전체 설정(컨텍스트 윈도우, nudge 임계값, 보호 구간, Governor, 프롬프트 템플릿): [`docs/INSTALL.md`](docs/INSTALL.md), [`docs/kernel-tuning.md`](docs/kernel-tuning.md).

## 제거 — 깨끗하고 완전하며 실측 검증됨

```bash
dsh plugin --profile web remove dsh-arc-context
```

호스트 재시작 후:

- 구성된 설정이 공식 Basic으로 돌아가며 ARC 행은 하나도 남지 않습니다;
- **preset 파일은 한 번도 수정되지 않습니다** (SHA-256 전후 동일, 릴리스 게이트에서 실측);
- 기존 세션은 계속 읽을 수 있습니다 — Basic이 ARC의 영구 로그를 직접 읽으며, 압축된 표면 형태가 유지되고 **원본이 컨텍스트로 홍수처럼 밀려오지 않습니다** (2,331 이벤트 세션의 완전한 가독성과 정상 투영을 실측);
- 새 세션에는 ARC 도구나 명령이 등록되지 않습니다.

재설치는 언제든 가능하며 첫 설치와 동일하게 동작합니다 (설치 → 제거 → 재설치 주기는 릴리스 게이트 매트릭스에서 항목별로 검증).

## 증거와 문서

- 연구 의제와 전체 결론: [`docs/research-agenda.md`](docs/research-agenda.md)
- 결과 데이터: [`research/results/`](research/results/) (릴리스 게이트 매트릭스, 페어 비교, 적대적 스위트)
- 설계 문서: [`docs/`](docs/) (설치, preset 통합, Governor 설계, 가역 설치 설계)
- 공개 증거 검증: `npm run research:verify`

## 크레딧 및 라이선스

ARC의 압축 코어는 [acp-kernel](https://github.com/ranxianglei/acp-kernel)(및 billion-context-pi, opencode-acp, ranxianglei, MIT)의 포트와 독립적 발전에서 비롯되었습니다. 호스트는 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DeepSeek AI)입니다. 본 프로젝트는 MIT 라이선스입니다 — [LICENSE](LICENSE).
