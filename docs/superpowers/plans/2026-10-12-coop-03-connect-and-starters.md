# 협동 모드 3단계: 연결 UI와 스타터 선택 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 각 Task는 실패하는 테스트 → 실패 확인 → 구현 → 통과 확인 → 커밋 순서로 진행한다.

**Goal:** 타이틀의 "협동 플레이 → 호스트 / 참가"로 두 클라이언트를 연결하고, 각자 자기 계정으로 스타터를 고른 뒤(코스트 한도 절반, 최대 3마리, 상대의 확정 픽만 표시, 레디/레디 취소), 두 클라이언트가 같은 파티(같은 id, 종, 소유자, 순서)와 같은 첫 웨이브 상태로 클래식 협동 런을 시작한다.

**Architecture:** 로직은 모두 `src/coop/`에 두고 코어는 얇은 훅만 단다.
- 스타터 페이로드(`coop-starter-payload.ts`): 로컬 `Starter`와 로컬 계정으로 페이로드를 만들고(소유자 쪽), 페이로드와 소유자 스냅샷만으로 `PlayerPokemon`을 만든다(양쪽 공통).
- 스타터 규칙(`coop-starter-rules.ts`): 코스트 한도 절반, 픽 수 한도 3.
- 스타터 선택 상태 기계(`coop-starter-selection.ts`): `CoopTransport` 위에서 확정 픽 송수신, 레디/취소, 호스트가 `start`(시드, 양쪽 스냅샷, 양쪽 픽, 기간 한정 이벤트)를 보내 시작을 확정한다.
- 게임 시작(`coop-game-start.ts`): 세션 생성(두 스냅샷을 먼저 넣고 `setCoopSession`), 공유 시드 심기, 호스트 픽 → 게스트 픽 순서로 생성, 파티 순서 `[호스트 1번, 게스트 1번, 호스트 나머지, 게스트 나머지]`, 소유권 등록.
- 연결(`coop-connect.ts`)과 로비(`coop-lobby.ts`): 호스트/참가 연결과 핸드셰이크, 연결된 뒤 게임 시작 전까지의 상태 보관과 정리.
- UI(`coop-title-menu.ts`, `coop-join-form-ui-handler.ts`, `coop-starter-select-ui.ts`, `coop-text.ts`): 타이틀 하위 메뉴, 참가 코드 입력 폼, 스타터 화면의 레디 제어와 파트너 픽 표시, 번역 키가 없을 때의 기본 문구.

**Tech Stack:** TypeScript, vitest(jsdom), 기존 `GameManager` 테스트 프레임워크, `LoopbackTransport`

**Spec:** `docs/superpowers/specs/2026-10-12-coop-mode-design.md` 3.1(연결), 3.2(스타터 선택), 3.3 첫 항목(필드 0 호스트, 필드 1 게스트), 4.3(협동 세션 계층), 4.4(게임 모드 행, 파티 크기 행), 4.5(스타터 페이로드)

**앞 계획:** `2026-10-12-coop-01-transport-foundation.md`(로드맵 3번), `2026-10-12-coop-02-determinism.md`(구현 메모 1·11번과 조사표 B의 "3단계" 항목, D의 남은 위험)

## Global Constraints

- **솔로 동작은 그대로다.** 모든 훅은 `globalScene.gameMode.isCoop`이 거짓이거나 `coopLobby`/`coopSession`이 `null`이면 기존 코드와 같은 값을 내고 같은 함수를 부른다.
- 코어(`src/` 중 `src/coop/` 바깥) 변경은 훅 호출과 import, 그리고 UI 모드 등록에 필요한 한 줄씩으로 제한한다. 주변 코드는 리팩터링하지 않는다.
- 협동 세션은 두 계정 스냅샷이 모두 들어간 뒤에만 `setCoopSession`으로 켠다(2단계 구현 메모 11번).
- 게스트 쪽에서 상대 스타터를 만들 때 로컬 `gameData`(`starterData`, `dexData`)를 읽지 않는다. 기술 검증은 소유자 스냅샷, 행운은 페이로드 값을 쓴다(스펙 4.5).
- 솔로 세이브 슬롯(0~4)을 건드리지 않는다. 협동 런은 스펙 4.6의 협동 전용 슬롯 번호 5를 쓴다(백엔드 지원과 호스트 전용 저장은 6단계).
- 번역 문구는 `locales` 서브모듈에 커밋하지 않는다. `coop:` 네임스페이스 키로 `i18next.t`를 부르되 `defaultValue`로 협동 코드 안의 한국어/영어 문구를 준다(스펙 3.7이 허용한 방식, 업스트림 머지 충돌이 적다).
- 새 파일은 kebab-case, biome 통과(경고 포함), REUSE 기본 표기(`src/**/*.ts`, `test/**/*.ts`) 적용.

## Review Focus

1. **양쪽 파티가 정말 같은가**: 같은 `start`로 호스트 역할과 게스트 역할이 각각 만든 파티의 id·종·소유자·순서가 같아야 한다. → Task 5 `host and guest build the same party from the start message`.
2. **계정이 달라도 첫 웨이브 상태가 같은가**: 게스트 로컬 계정이 trainerId, 알 기술, 해금, 도감이 달라도 첫 웨이브 해시가 같아야 한다. 호스트 픽에 호스트만 해금한 알 기술을 넣어 게스트 로컬 데이터를 읽으면 깨지게 만든다. → Task 5 `first wave hash matches between host and guest with different accounts`.
3. **레디 경합**: 게스트가 레디를 취소하는 메시지와 호스트의 `start`가 엇갈리면 호스트의 `start`가 이긴다(양쪽이 같은 픽으로 시작). → Task 3 `the host start wins over a crossing unready`.
4. **확정한 픽만 보이는가**: 레디 전에는 픽이 상대에게 가지 않고, 레디를 취소하면 상대 화면에서 지워진다. → Task 3 `sends picks only when ready`, `clears the partner picks on unready`.
5. **솔로 회귀**: 코스트 한도 10, 파티 6마리, 기간 한정 이벤트 판정, 타이틀 메뉴(릴레이 주소가 없으면 협동 항목 없음). → Task 2, Task 4, Task 7 각 `solo` 테스트.

---

## 조사 결과

### A. 연결 지점

| 지점 | 파일 | 현재 동작 | 협동 훅 |
|---|---|---|---|
| 타이틀 메뉴 | `src/phases/title-phase.ts` `showOptions` | 이어하기/새 게임/불러오기/런 기록/메뉴 옵션을 `UiMode.TITLE`로 띄움. 하위 메뉴는 `UiMode.OPTION_SELECT` 오버레이 | 릴레이 주소가 설정돼 있으면 "협동 플레이" 항목 추가. 하위 메뉴와 연결은 `showCoopTitleMenu`에 위임 |
| 새 게임 시작 | `TitlePhase.end` | `globalScene.gameMode = getGameMode(this.gameMode)` 후 `SelectStarterPhase` 추가 | 로비가 있으면 `createCoopGameMode()` |
| 타이틀 복귀 | `TitlePhase.start` | — | `leaveCoop()`로 남은 로비/세션/연결을 닫는다(솔로에서는 아무 일 없음) |
| 스타터 선택 → 런 시작 | `src/phases/select-starter-phase.ts` | UI 콜백 → 세이브 슬롯 선택 → `initBattle(starters)`가 스타터 생성, 로컬 `dexData`로 행운, 로컬 `starterData`로 기술 검증 후 `newBattle` | 로비가 있으면 세이브 슬롯 선택을 건너뛰고 `startCoopRunFromLobby(() => this.initBattle([]))`. 파티는 협동 코드가 먼저 채우고 `initBattle([])`은 뒷부분(오버라이드, `newBattle`, 아레나 초기화)만 실행 |
| 코스트 한도 | `src/ui/utils/starter-select-ui-utils.ts` `getRunValueLimit` | 클래식 10(챌린지 적용) | 반환값을 `applyCoopValueLimit`에 통과(협동이면 절반) |
| 파티 수 한도 | `starter-select-ui-handler.ts` 파티 추가 메뉴(`PLAYER_PARTY_MAX_SIZE`), 랜덤 선택(`>= 6`) | 6 | `getStarterPickLimit()`(협동이면 3) |
| 시작 확인 | `starter-select-ui-handler.ts` `tryStart`의 `startRun` | 콜백 호출 후 화면 종료 | 협동이면 콜백 대신 레디(`coopUi.confirm`) |
| 입력 | `starter-select-ui-handler.ts` `processInput` | — | 레디 중에는 협동 컨트롤러가 입력을 먼저 받는다(취소 = 레디 취소, 나머지는 막음) |
| 기간 한정 이벤트 | `src/timed-event-manager.ts` `isActive` | `new Date()`로 판정 | 협동이면 세션의 이벤트 이름과 같은지로 판정 |
| 참가 코드 입력 | `src/enums/ui-mode.ts`, `src/ui/ui.ts` | 텍스트 입력 폼은 `FormModalUiHandler` 하위 클래스로 UI 모드마다 등록 | `UiMode.COOP_JOIN_FORM`과 `CoopJoinFormUiHandler` 등록 |
| 게임 모드 | `src/game-mode.ts` | `GameModeConfig` | `isCoop` 필드 추가(기본 `false`). `GameModes`에 새 값 없음 |

### B. 스타터 생성이 읽는 값 (`SelectStarterPhase.initBattle`)

| 값 | 출처 | 협동 처리 |
|---|---|---|
| 종, 폼, 성별, 이로치, 변종, 특성 인덱스, 성격, 개체값 | UI의 `Starter` | 페이로드 |
| 기술 | `Starter.moveset`, `tryPopulateMoveset`이 로컬 `starterData[root].eggMoves`로 재검증 | 페이로드 + 소유자 스냅샷 알 기술로 검증(`getPokemonSimData`) 후 `tryPopulateMoveset(moveset, true)` |
| 패시브, 포켓러스, 닉네임, 테라 타입 | `Starter` | 페이로드(테라 타입이 없으면 소유자가 `species.type1`로 채움) |
| 행운 | 로컬 `getDexAttrLuck(dexData[종].caughtAttr)` | 소유자가 계산해 페이로드에 담음 |
| 우정, 포켓볼 | 생성자 기본값(`baseFriendship`, `POKEBALL`) | 페이로드(스펙 4.5 목록, 앞으로 계정별로 달라질 때 대비) |
| id, 테라 타입 롤 | 생성자 `randSeedInt`, `randSeedItem` | 공유 시드를 심은 뒤 같은 순서로 생성 |
| 코스트 | 로컬 `getSpeciesStarterValue`(캔디 감소 반영) | 소유자 화면에서만 검사. 받는 쪽은 재검사하지 않는다(신뢰 기반, 스펙 2장) |

### C. 2단계 인계 사항 처리

| # | 인계 내용 | 처리 |
|---|---|---|
| 1 | 세션은 두 스냅샷을 모두 넣은 뒤 켠다 | 게스트 스냅샷은 `starters.account`, 호스트 스냅샷은 `start.hostWorldData`. `start`에는 게스트 스냅샷(`guestAccount`)도 되돌려 실어, 양쪽이 같은 메시지 하나로 세션을 만든다. `beginCoopSession`이 두 스냅샷을 넣은 뒤 `setCoopSession` |
| 2 | 스타터 id가 생성 시점 RNG에 달려 있다 | **공유 시드를 먼저 심고 같은 순서로 생성**한다(`setSeed(start.seed)` → `resetSeed()` → 호스트 픽 → 게스트 픽). 페이로드에 id를 싣는 방식은 쓰지 않는다. 이유: 생성자는 id 말고도 테라 타입 롤(`randSeedItem`)로 공유 RNG를 소비하므로 id만 맞춰서는 RNG 상태가 맞지 않고, 어차피 첫 웨이브 생성 전에 RNG 상태가 같아야 한다. id를 실으려면 생성자 경로도 바꿔야 해서 코어 침투가 커진다 |
| 3 | `tryPopulateMoveset`과 스타터 행운이 로컬 `gameData`를 읽는다 | 위 B표. 코어 `tryPopulateMoveset`은 그대로 두고 협동 생성 경로에서 검증을 건너뛰는 인자(`ignoreValidate = true`)로 부르기 전에 소유자 스냅샷으로 검증한다 |
| 4 | 기간 한정 이벤트가 벽시계 기준 | 게임 시작 범위에 포함한다(첫 웨이브 적의 이로치 배율, 이벤트 인카운터에 영향). 호스트가 `start.timedEvent`에 활성 이벤트 이름(없으면 `null`)을 싣고, 협동 중 `isActive`는 그 이름과 같은 이벤트만 활성으로 본다 |

---

## 파일 구조

```
src/coop/
  coop-protocol.ts            (수정) CoopStarterPayload, starters.account, start의 픽·스냅샷·이벤트
  coop-session.ts             (수정) timedEvent, getCoopTimedEvent
  coop-starter-payload.ts     buildStarterPayload, createStarterFromPayload
  coop-starter-rules.ts       applyCoopValueLimit, getStarterPickLimit
  coop-starter-selection.ts   CoopStarterSelection(레디 상태 기계), CoopStartInfo
  coop-game-start.ts          createCoopGameMode, beginCoopSession, assembleCoopParty, startCoopRun, COOP_SESSION_SLOT
  coop-connect.ts             hostCoop, joinCoop, isCoopAvailable, CoopJoinInputError
  coop-lobby.ts               coopLobby, openCoopLobby, leaveCoop, startCoopRunFromLobby
  coop-text.ts                coopText(키, 기본 문구)
  coop-title-menu.ts          showCoopTitleMenu
  coop-join-form-ui-handler.ts  참가 코드 입력 폼
  coop-starter-select-ui.ts   CoopStarterSelectController, 파트너 픽 표시
test/tests/coop/
  coop-starter-payload.test.ts, coop-starter-rules.test.ts, coop-starter-selection.test.ts,
  coop-game-start.test.ts, coop-connect.test.ts, coop-title-menu.test.ts, coop-starter-select-ui.test.ts
test/utils/
  coop-replay.ts              (수정) 실제 협동 시작 경로로 게임 시작(startCoopBattle)
```

---

### Task 1: 프로토콜 타입 좁히기와 스타터 페이로드

**Files:**
- Modify: `src/coop/coop-protocol.ts`
- Create: `src/coop/coop-starter-payload.ts`
- Test: `test/tests/coop/coop-starter-payload.test.ts`, `test/tests/coop/coop-protocol.test.ts`(왕복 테스트에 새 필드)

**Interfaces:**
- Produces (`coop-protocol.ts`):
  ```ts
  export interface CoopStarterPayload {
    speciesId: SpeciesId; formIndex: number; gender: Gender; shiny: boolean; variant: Variant;
    abilityIndex: number; passive: boolean; nature: Nature; ivs: number[];
    /** 비어 있으면 기본 기술 */ moveset: MoveId[];
    teraType: PokemonType; friendship: number; pokeball: PokeballType;
    nickname?: string; pokerus: boolean; luck: number;
  }
  | { t: "starters"; picks: CoopStarterPayload[]; ready: boolean; account: CoopAccountSnapshot }
  | { t: "start"; seed: string; hostWorldData: CoopWorldData; guestAccount: CoopAccountSnapshot;
      hostPicks: CoopStarterPayload[]; guestPicks: CoopStarterPayload[]; timedEvent: string | null }
  ```
- Produces (`coop-starter-payload.ts`):
  - `export type StarterPayloadAccount = Pick<GameData, "dexData" | "getDexAttrLuck">`
  - `export function buildStarterPayload(starter: Starter, account: StarterPayloadAccount = globalScene.gameData): CoopStarterPayload` — 성별은 `malePercent === null`이면 무성, 아니면 `female`로. 테라 타입이 없으면 `species.type1`. 행운은 `account.getDexAttrLuck(account.dexData[speciesId].caughtAttr)`. 우정 `species.baseFriendship`, 볼 `POKEBALL`.
  - `export function createStarterFromPayload(payload: CoopStarterPayload, level: number, owner: CoopRole): PlayerPokemon` — 협동 세션 필수(없으면 throw). `addPlayerPokemon`으로 만들고 곧바로 `coopSession.ownership.set(id, owner)`, 기술은 `getPokemonSimData(id).getEggMoveBits(root)`로 검증 후 `tryPopulateMoveset(moveset, true)`, 나머지 필드를 페이로드로 채우고 `setVisible(false)`. 로컬 `gameData`를 읽지 않는다.

- [x] **Step 1: 실패 테스트**
  - `coop-protocol.test.ts` `round-trips every message kind`에 새 `starters`, `start` 모양 추가.
  - `coop-starter-payload.test.ts`:
    - `builds a payload from a starter and the local account` (GameManager): 이로치 변종 2 암컷 이상해씨, 닉네임, 알 기술 포함 기술. 로컬 `dexData`의 `caughtAttr`에 `SHINY | VARIANT_3`이 있으면 `luck === 3`, `gender === Gender.FEMALE`, 테라 타입 없으면 `PokemonType.GRASS`, JSON 왕복과 같다.
    - `creates the pokemon from the payload only`: 게스트 세션(호스트 스냅샷에 이상해씨 알 기술 비트 1)에서 호스트 소유 페이로드로 만들면 알 기술이 기술 배치에 들어가고, 로컬 `starterData`를 지우거나(알 기술 0) `dexData` 행운 정보를 바꿔도 결과가 같다. 소유권이 등록된다.
    - `rejects an egg move the owner has not unlocked`: 소유자 스냅샷 알 기술 0이면 기술 배치가 기본(빈 배치)으로 남는다.
    - `throws outside co-op`.
- [x] **Step 2: 실패 확인** — Run: `pnpm test test/tests/coop/coop-starter-payload.test.ts` / Expected: FAIL, 모듈 없음
- [x] **Step 3: 구현** → **Step 4: 통과 확인** (`pnpm test test/tests/coop && pnpm typecheck`)
- [x] **Step 5: 커밋** — `feat(coop): add starter payloads`

---

### Task 2: 게임 모드 `isCoop`과 스타터 규칙

**Files:**
- Modify: `src/game-mode.ts`(`GameModeConfig.isCoop`, `public isCoop = false`), `src/ui/utils/starter-select-ui-utils.ts`(`getRunValueLimit` 반환 한 줄)
- Create: `src/coop/coop-starter-rules.ts`, `src/coop/coop-game-start.ts`(이 Task에서는 `createCoopGameMode`만)
- Test: `test/tests/coop/coop-starter-rules.test.ts`

**Interfaces:**
- `export function createCoopGameMode(): GameMode` — `getGameMode(GameModes.CLASSIC)`에 `isCoop = true`. `modeId`는 `CLASSIC` 그대로.
- `export function applyCoopValueLimit(limit: number): number` — `globalScene.gameMode.isCoop`이면 `limit / 2`(반올림하지 않음, 한도 10 → 5), 아니면 그대로.
- `export function getStarterPickLimit(): number` — 협동이면 `COOP_MAX_OWNED`(3), 아니면 `PLAYER_PARTY_MAX_SIZE`(6).

- [x] **Step 1: 실패 테스트** (GameManager)
  - `co-op is a flag on classic`: `createCoopGameMode()`는 `modeId === CLASSIC`, `isClassic`, `isCoop`; `getGameMode(CLASSIC).isCoop === false`.
  - `halves the run value limit in co-op`: 협동 게임 모드면 `getRunValueLimit() === 5`, 솔로 클래식 `10`.
  - `limits picks to three in co-op`: `getStarterPickLimit()`이 협동 3, 솔로 6.
- [x] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [x] **Step 5: 커밋** — `feat(coop): add co-op game mode flag and starter limits`

---

### Task 3: 스타터 선택 상태 기계

**Files:**
- Create: `src/coop/coop-starter-selection.ts`
- Test: `test/tests/coop/coop-starter-selection.test.ts` (loopback, GameManager 없음)

**Interfaces:**
- `export interface CoopStartInfo { seed: string; accounts: Record<CoopRole, CoopAccountSnapshot>; picks: Record<CoopRole, CoopStarterPayload[]>; timedEvent: string | null }`
- `export interface CoopStarterSelectionOptions { getAccount(): CoopAccountSnapshot; createSeed?(): string; getTimedEvent?(): string | null }` — 기본값은 `randomString(24)`, `timedEventManager.activeEvent()?.name ?? null`(호스트만 씀).
- `export class CoopStarterSelection`
  - `constructor(role: CoopRole, transport: CoopTransport, options)`
  - `get localReady(): boolean`, `get partner(): { picks: readonly CoopStarterPayload[]; ready: boolean }`, `get startInfo(): CoopStartInfo | null`, `get closed(): boolean`
  - `setReady(picks: CoopStarterPayload[]): void` — 1~3마리가 아니거나 시작/종료 후면 throw. `starters { picks, ready: true, account: getAccount() }` 전송.
  - `cancelReady(): boolean` — 시작했으면 `false`. 아니면 `starters { picks: [], ready: false, account }` 전송 후 `true`.
  - `onChange(handler): Unsubscribe`, `onStart(handler: (info) => void): Unsubscribe`, `dispose(): void`
  - 규칙: 상대 `starters`는 `ready`일 때만 픽을 보관(아니면 빈 배열). 호스트는 자신과 상대가 모두 레디가 되는 순간 `start`를 보내고 시작한다. 게스트는 `start`를 받으면 시작한다(로컬에서 레디를 취소했더라도 호스트의 `start`가 이긴다). 시작 후 `starters`는 무시. `bye`나 연결 `closed`면 `closed = true`.

- [x] **Step 1: 실패 테스트**
  - `sends picks only when ready`: 게스트가 레디하기 전 호스트의 `partner.picks`는 비어 있고, 레디 후 게스트 픽 1마리가 보인다.
  - `clears the partner picks on unready`: 게스트 레디 → 취소하면 호스트의 `partner`가 `{ picks: [], ready: false }`.
  - `starts when both are ready`: 양쪽 레디 후 두 쪽의 `startInfo`가 같고(`toEqual`), 시드는 호스트 `createSeed` 값, `accounts`는 각자 보낸 스냅샷, `timedEvent`는 호스트 값.
  - `allows cancelling ready while the partner is still picking`: 호스트 레디 → 취소 → 다시 레디(다른 픽) → 게스트 레디 후 시작 정보의 호스트 픽은 마지막 픽.
  - `the host start wins over a crossing unready`: 호스트 레디, 게스트 레디와 거의 동시에 게스트가 취소하면(메시지 전달 전 `cancelReady`) 게스트는 `start`를 받아 레디했던 픽으로 시작하고 `cancelReady()`는 이후 `false`.
  - `rejects more than three picks`, `marks the selection closed when the peer leaves`.
- [x] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [x] **Step 5: 커밋** — `feat(coop): add starter selection state machine`

---

### Task 4: 게임 시작 — 세션, 시드, 파티, 기간 한정 이벤트

**Files:**
- Modify: `src/coop/coop-session.ts`(`timedEvent: string | null`, `getCoopTimedEvent()`), `src/timed-event-manager.ts`(`isActive` 훅 한 줄), `src/phases/select-starter-phase.ts`(협동 분기)
- Create/Modify: `src/coop/coop-game-start.ts`, `src/coop/coop-lobby.ts`
- Test: `test/tests/coop/coop-game-start.test.ts`

**Interfaces:**
- `export const COOP_SESSION_SLOT = 5` (스펙 4.6)
- `export function beginCoopSession(role, transport, start: CoopStartInfo): CoopSession` — 두 스냅샷과 이벤트를 넣고 `setCoopSession`.
- `export function assembleCoopParty(start: CoopStartInfo, level: number): PlayerPokemon[]` — 생성 순서 호스트 픽 → 게스트 픽, 반환 순서 `[호스트 0, 게스트 0, 호스트 1.., 게스트 1..]`.
- `export async function startCoopRun(role, transport, start, initBattle: () => void): Promise<void>` — `beginCoopSession` → `sessionSlotId = COOP_SESSION_SLOT` → `setSeed(start.seed)`·`resetSeed()` → `assembleCoopParty`를 `globalScene` 파티에 넣고 에셋 로드 → `initBattle()`.
- `coop-lobby.ts`: `export interface CoopLobby { role; transport; peerAccountName; selection }`, `export let coopLobby`, `openCoopLobby(connection)`, `leaveCoop()`(로비·세션 정리, `bye` 후 연결 종료), `startCoopRunFromLobby(initBattle)`.
- `getCoopTimedEvent(): string | null | undefined` — 협동이 아니면 `undefined`.

- [x] **Step 1: 실패 테스트** (GameManager)
  - `assembles host picks first on the field`: 호스트 2마리, 게스트 3마리면 파티 종 순서가 `[h0, g0, h1, g1, g2]`, 소유자가 맞고, 더블 배틀 첫 턴 필드 0은 호스트, 1은 게스트.
  - `creates starters from the shared seed`: 같은 `start`로 두 번 만들면 id가 같다(사이에 공유 RNG를 다른 값으로 소비해도).
  - `uses the co-op session slot`: 시작 후 `sessionSlotId === 5`.
  - `uses the host's timed event in co-op`: 비활성 기간의 가짜 이벤트가 협동에서 `timedEvent`가 그 이름이면 활성, 솔로면 비활성(관리자 `disabled`를 잠시 끔).
- [x] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [x] **Step 5: 커밋** — `feat(coop): start a co-op run from the start message`

---

### Task 5: 종단 확인 — loopback 선택에서 같은 파티와 같은 첫 웨이브

**Files:**
- Modify: `test/utils/coop-replay.ts`(실제 협동 시작 경로 `startCoopBattle`; `runCoopReplay`도 이 경로로 시작)
- Test: `test/tests/coop/coop-game-start.test.ts`(종단), 기존 `coop-desync-replay.test.ts` 그대로 통과

**Interfaces:**
- `export async function startCoopBattle(game: GameManager, options: { role: CoopRole; start: CoopStartInfo }): Promise<void>` — 타이틀까지 간 뒤 협동 게임 모드를 켜고 `startCoopRun(..., () => new SelectStarterPhase().initBattle([]))`, `CommandPhase`까지.
- `export async function selectCoopStart(host: {...}, guest: {...}): Promise<CoopStartInfo>` — loopback 쌍 위에서 두 `CoopStarterSelection`을 레디시켜 양쪽 시작 정보를 얻고 같은지 확인.

- [x] **Step 1: 실패 테스트**
  - `host and guest build the same party from the start message`: loopback 선택으로 얻은 호스트·게스트 시작 정보 각각으로 (호스트 계정, 호스트 역할) 실행과 (게스트 계정, 게스트 역할) 실행을 하고 파티의 `[id, speciesId, owner]` 열이 같다.
  - `first wave hash matches between host and guest with different accounts`: 위 두 실행의 첫 `CommandPhase` 해시(`computeCoopStateHash`)가 같다. 호스트 픽은 호스트만 해금한 알 기술을 쓰고, 게스트 로컬 계정은 trainerId·해금·알 기술이 다르다.
  - 기존 `coop-desync-replay.test.ts` 4개가 새 시작 경로로도 통과.
- [x] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [x] **Step 5: 커밋** — `test(coop): check both roles start the same run`

---

### Task 6: 연결과 로비

**Files:**
- Create: `src/coop/coop-connect.ts` (`coop-lobby.ts`의 `openCoopLobby` 보강)
- Test: `test/tests/coop/coop-connect.test.ts`

**Interfaces:**
- `export interface CoopConnection { role: CoopRole; transport: CoopTransport; peerAccountName: string }`
- `export interface CoopLocalInfo { gameVersion: string; accountName: string }` — 기본값 `getLocalCoopInfo()`: `#package.json`의 `version`, `loggedInUser?.username`(없으면 `"Guest"`).
- `export async function hostCoop(transport, onJoinCode: (code: string) => void, local = getLocalCoopInfo()): Promise<CoopConnection>` — `host()` → `onJoinCode` → 상태 `"connected"` 대기 → `performHandshake`.
- `export async function joinCoop(input: string, options?: { local?; defaultRelayUrl?; createTransport? }): Promise<CoopConnection>` — `parseJoinInput`(기본 릴레이 `getDefaultRelayUrl()`), 실패하면 `CoopJoinInputError`. `createTransport` 기본은 `new RelayWebSocketTransport(url)`.
- `export function isCoopAvailable(relayUrl = getDefaultRelayUrl()): boolean`
- `openCoopLobby(connection)`: 로비 저장, `CoopStarterSelection` 생성(`getAccount: () => createAccountSnapshot(globalScene.gameData)`).

- [x] **Step 1: 실패 테스트**
  - `connects host and guest through the handshake`: loopback에서 `hostCoop`이 코드 `LOOP00`을 알려 주고, 같은 코드로 `joinCoop`(가짜 `createTransport`)하면 양쪽이 상대 이름을 받는다.
  - `rejects a malformed join code without connecting`: `joinCoop("ab")`는 `CoopJoinInputError`, `createTransport`가 불리지 않는다.
  - `uses the address in the join input as the relay`: `"192.168.0.10:8787/abc123"`이면 `createTransport`가 `ws://192.168.0.10:8787`로 불린다.
  - `rejects a version mismatch`: 상대 버전이 다르면 `CoopVersionMismatchError`.
  - `co-op needs a relay url`: `isCoopAvailable(undefined) === false`, `isCoopAvailable("wss://r") === true`.
  - `leaving closes the lobby`: `openCoopLobby` 후 `leaveCoop()`이면 상대가 `closed`를 보고 `coopLobby === null`.
- [x] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [x] **Step 5: 커밋** — `feat(coop): add host and join connection flow`

---

### Task 7: 타이틀 메뉴와 참가 코드 폼

**Files:**
- Modify: `src/phases/title-phase.ts`(옵션 한 개, `end`의 게임 모드 한 줄, `start`의 `leaveCoop()`), `src/enums/ui-mode.ts`(`COOP_JOIN_FORM`), `src/ui/ui.ts`(핸들러·전환 없는 모드 등록)
- Create: `src/coop/coop-text.ts`, `src/coop/coop-title-menu.ts`, `src/coop/coop-join-form-ui-handler.ts`
- Test: `test/tests/coop/coop-title-menu.test.ts`

**Interfaces:**
- `export function coopText(key: CoopTextKey, options?: TOptions): string` — `i18next.t("coop:<key>", { defaultValue })`. 기본 문구는 언어가 `ko`로 시작하면 한국어, 아니면 영어.
- `export function showCoopTitleMenu(callbacks: { onConnected(): void; onCancel(): void }, deps?: { createTransport?; local? }): void` — `OPTION_SELECT`로 "호스트 / 참가 / 취소". 호스트는 코드를 메시지로 보여 주고 "취소" 버튼을 둔다. 참가는 `COOP_JOIN_FORM`을 띄운다. 연결되면 `openCoopLobby` 후 `onConnected`. 실패하면 이유(코드 형식, 코드 없음, 방 가득 참, 버전 다름, 연결 실패)를 보여 주고 `onCancel`.
- `TitlePhase`: `isCoopAvailable()`일 때만 "협동 플레이" 항목. `onConnected`는 `gameMode = CLASSIC` 후 `end()`, `end()`는 로비가 있으면 `createCoopGameMode()`.

- [x] **Step 1: 실패 테스트** (GameManager)
  - `hides co-op without a relay url` / `shows co-op with a relay url`: `vi.stubEnv("VITE_COOP_RELAY_URL", ...)` 후 타이틀 옵션 라벨에 협동 항목 유무.
  - `hosting shows the join code and starts co-op starter select`: 가짜 `createTransport`(loopback 호스트 쪽)로 호스트를 고르면 메시지에 `LOOP00`이 보이고, 게스트가 같은 쌍으로 참가·핸드셰이크하면 `coopLobby`가 생기고 `SelectStarterPhase`로 넘어가며 `gameMode.isCoop`.
  - `join shows an error for a malformed code`: 폼에 `"x"`를 넣으면 형식 오류 문구를 보여 준다.
  - `falls back to built-in text when a key is missing`: `coopText("hostGame")`가 키 문자열이 아닌 기본 문구.
- [x] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [x] **Step 5: 커밋** — `feat(coop): add co-op title menu and join form`

---

### Task 8: 스타터 선택 화면 연결

**Files:**
- Modify: `src/ui/handlers/starter-select-ui-handler.ts`(픽 한도 두 곳, `show`에서 컨트롤러 생성, `processInput` 첫 줄, `startRun` 레디 분기, `clear`에서 정리)
- Create: `src/coop/coop-starter-select-ui.ts`
- Test: `test/tests/coop/coop-starter-select-ui.test.ts`

**Interfaces:**
- `export interface CoopPartnerView { setPartner(picks: readonly CoopStarterPayload[], ready: boolean): void; setStatus(text: string): void; destroy(): void }`
- `export class CoopStarterSelectController` — `constructor(selection: CoopStarterSelection, view: CoopPartnerView, onStart: (starters: Starter[]) => void)`
  - `confirm(starters: Starter[]): boolean` — 페이로드로 바꿔 `setReady`, 상태 "파트너를 기다리는 중". 항상 `true`(협동에서는 콜백 대신 레디).
  - `processInput(button: Button): boolean` — 레디 중이면 입력을 먹는다. `CANCEL`이면 `cancelReady`. 레디가 아니면 `false`.
  - 시작되면 `onStart(마지막으로 레디한 로컬 Starter)`.
- `export function createCoopStarterSelectUi(layout): CoopStarterSelectController | null` — 로비가 없으면 `null`. 파트너 픽은 팀 창 4~6번 칸에 아이콘으로, 상태는 코스트 라벨 왼쪽에 글자로 표시.

- [x] **Step 1: 실패 테스트** (가짜 뷰, loopback, GameManager는 종 데이터용)
  - `confirming sends ready instead of starting`: `confirm` 후 상대가 레디 픽을 받고 `onStart`는 아직 안 불린다.
  - `cancel during ready unreadies`: 레디 중 `processInput(CANCEL)`이 `true`, 상대가 `ready: false`를 본다. 레디가 아닐 때는 `false`.
  - `shows the partner's confirmed picks`: 상대가 레디하면 뷰에 상대 픽과 `ready: true`.
  - `starts with the local starters when both are ready`: 양쪽 레디면 `onStart`가 로컬 `Starter` 배열로 불린다.
- [x] **Step 2: 실패 확인** → **Step 3: 구현과 핸들러 훅** → **Step 4: 통과 확인**
- [x] **Step 5: 커밋** — `feat(coop): wire co-op ready flow into starter select`

---

### Task 9: 마무리 확인

- [x] **Step 1:** Run: `pnpm test test/tests/coop && pnpm typecheck && pnpm biome:ci && pnpm exec ls-lint && pnpm coop:server:test` / Expected: 통과
- [x] **Step 2:** 훅을 지나는 기존 테스트 묶음(`test/tests/phases`, `test/tests/ui`, 타이틀·스타터·기간 한정 이벤트 관련) 실행 / Expected: 변경 전과 같은 결과
- [x] **Step 3:** 전체 `pnpm test:silent`(백그라운드)
- [x] **Step 4:** 이 문서에 "구현 메모" 추가, 체크박스 갱신, 커밋 — `docs: mark co-op connect and starters plan progress`

---

## 구현 메모 (계획과 달라진 점)

구현하면서 계획과 다르게 정하거나 새로 알게 된 부분이다. 4단계 이후 계획은 이 내용을 기준으로 작성한다.

1. **Task 순서 조정**: `coop-lobby.ts`(로비, `leaveCoop`, `startCoopRunFromLobby`)는 Task 4가 아니라 Task 6에서 만들었고, `SelectStarterPhase`의 협동 분기는 Task 8에서 달았다. 둘 다 연결·화면 흐름이 있어야 의미가 있어서다. Task 4는 세션·시드·파티·기간 한정 이벤트만 다룬다.
2. **기록-재생 도구가 실제 시작 경로를 쓴다**: `runCoopReplay`는 이제 `startCoopBattle`(타이틀 → 협동 게임 모드 → `startCoopRun` → `initBattle([])`)으로 게임을 시작한다. 스타터는 고정값 페이로드(`createTestStarterPayload`)이고, `worldDataOverride`는 `start`의 호스트 스냅샷을 바꾼다. 2단계 `coop-desync-replay.test.ts` 4개는 고치지 않고 통과했다. `game.override.seed` 대신 `start.seed`가 공유 시드다.
3. **타이틀로 돌아가면 협동을 떠난다**: `TitlePhase.start`가 `leaveCoop()`을 불러 로비·세션·연결을 정리한다(협동 런이 끝난 뒤 솔로 게임에 남은 세션이 새지 않게). 그래서 테스트는 타이틀을 지난 뒤에 세션을 열어야 한다. 2단계 `coop-random-call-sites.test.ts`의 GTS 테스트가 인카운터 진입 전에 세션을 열고 있어서, 인카운터 진입 후에 열도록 바꿨다(검사 내용은 같음).
4. **`start`는 자기완결 메시지다**: 계획대로 호스트 스냅샷(`hostWorldData`)과 게스트 스냅샷(`guestAccount`), 양쪽 픽, 이벤트를 모두 싣는다. `starters`는 레디 여부와 상관없이 보낸 사람의 스냅샷(`account`)을 늘 싣는다(레디 취소 때 픽은 빈 배열).
5. **시작 금액**: 솔로에서는 스타터 화면의 `startRun`이 `money`를 정한다. 협동에서는 `startCoopRun`이 다시 `getStartingMoney()`로 정한다(화면을 거치지 않는 경합 경로와 테스트에서도 양쪽이 같게).
6. **세이브 슬롯 5 (임시)**: `startCoopRun`이 `sessionSlotId`를 `COOP_SESSION_SLOT = 5`로 바꾼다. 백엔드가 슬롯 5를 받기 전(6단계)에는 서버 저장이 범위 오류로 실패하고 솔로 슬롯 0~4는 건드리지 않는다. 오프라인(`bypassLogin`)이면 로컬 슬롯 5 키에 쓰는데, 세이브 슬롯 화면은 0~4만 보여 준다. 지금은 게스트도 슬롯 5에 쓰려 한다. 6단계에서 게스트 저장을 막아야 한다.
7. **헤드리스에서 띄울 수 없는 화면**: 스타터 선택 화면의 `show()`는 헤드리스 테스트에서 `StarterContainer.setSpecies`가 던져서 실행되지 않는다(기존 `test/tests/ui/starter-select.test.ts`가 todo인 이유와 같음). 그래서 핸들러 훅(`show`의 컨트롤러 생성, `processInput` 첫 줄, `startRun` 레디 분기, `clear` 정리, 픽 한도 두 곳)은 테스트가 직접 지나지 않는다. 대신 컨트롤러는 가짜 뷰로, Phaser 뷰는 컨테이너에 붙는 개수와 아이콘 표시로, 단계 훅은 화면이 부를 콜백을 가로채 시험했다. 참가 코드 폼도 헤드리스 입력창에 `setFocus`가 없어 띄우지 않고 폼 설정(`buttonActions`)을 가로채 시험했다.
8. **UI 모드가 GameManager보다 오래 산다**: 같은 Phaser 게임을 쓰는 다음 테스트에서 이미 `TITLE` 모드면 `setMode(TITLE)`이 무시되어 앞 테스트의 옵션이 남는다. 타이틀 메뉴 테스트는 시작 전에 `MESSAGE` 모드로 돌려 둔다.
9. **문구**: `coopText`는 `i18next.t("coop:<키>", { defaultValue })`이고 기본 문구는 `i18next.language`가 `ko`로 시작하면 한국어, 아니면 영어다. 레디 대기 문구는 공간이 좁아 한 줄("준비 완료! 취소로 다시 고르기")로 줄였다.
10. **화면 배치 (설계자 판단, 눈으로 확인하지 못함)**: 파트너의 확정 픽은 팀 창의 4~6번 칸에 아이콘으로, 상태 문구는 "시작" 라벨 왼쪽(`teamWindowX - 4, 162`)에 오른쪽 정렬로 그린다.
11. **회귀 확인 (로컬)**: JSON 전용 `assets`로 전체 `pnpm test:silent`를 돌렸다. 테스트 파일 471개 통과·1개 실패·8개 건너뜀, 테스트 3220개 통과·8개 실패·6개 건너뜀·111개 todo. 실패 8개는 모두 `test/tests/pokemon/pokemon-sprite.test.ts`(이미지 없음, 환경 문제)다. 그 뒤 시작 금액 변경(5번) 후 `test/tests/coop` 19개 파일 128개 테스트가 통과했다. 최종 확인은 GitHub Actions `Tests` 워크플로우로 한다.
12. **4단계 이후로 넘기는 것**: 협동 런이 시작된 뒤 명령 분배가 없어 지금은 한 클라이언트가 두 필드 자리를 모두 조작한다(4단계). 선택 중 연결이 끊기면 상태 문구만 바뀌고 재접속·자동 복귀는 없다(6단계). 협동 시작도 `classicSessionsPlayed`를 올린다(7단계에서 협동 통계로 나눌지 결정). 스타터 화면의 핑, 상대 픽 상세(이로치·특성) 표시는 없다.
13. **회귀 확인 (CI)**: GitHub Actions `Tests` 워크플로우(run 38230747524, 커밋 46f1c93)에서 테스트 파일 472개 통과·8개 건너뜀, 테스트 3229개 통과·실패 0으로 확인했다.
