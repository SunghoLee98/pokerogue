<!--
SPDX-FileCopyrightText: 2026 SunghoLee98

SPDX-License-Identifier: CC-BY-NC-SA-4.0
-->

# 협동 모드 7단계: 계정 진행도와 기록 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 각 Task는 실패하는 테스트 → 실패 확인 → 구현 → 통과 확인 → 커밋 순서로 진행한다. 로직을 테스트보다 먼저 쓰지 않는다(4단계 메모 5번, 5단계 메모 5번의 순서 위반을 반복하지 않는다).

**Goal:** 협동 런에서 생기는 계정 기록(도감 "잡음", 개체값, 캔디, 특성·성격·알 기술 해금, 리본)은 **그 포켓몬 주인의 계정에만** 쌓이고, 상대 클라이언트는 그 포켓몬을 "봤음"으로만 남긴다. 각 클라이언트는 자기 계정만 쓰고 상대 계정은 절대 쓰지 않는다. 미스터리 인카운터(ME)에서 얻은 포켓몬은 고른 사람 소유이고 3마리 한도를 지킨다. 협동 런 중에는 알이 부화하지 않는다. 협동 클리어는 클래식 클리어로 치지 않고 두 사람 모두에게 새 업적 "협동 클리어"를 준다. 협동 런은 솔로 통계 대신 협동 통계(시작·클리어 횟수)를 올리고, 런 히스토리 화면의 "협동 기록" 탭에만 보인다. 계정 쓰기는 공유 시뮬레이션과 상태 해시를 바꾸지 않는다(기록-재생으로 확인).

**Architecture:** 로직은 `src/coop/`에 두고 코어는 얇은 훅만 단다.
- 계정 기록 규칙(`coop-account.ts`): "이 포켓몬의 기록이 내 계정에 들어가는가"(`coopCreditsLocalAccount(pokemon)`). 솔로는 늘 참. 협동은 소유권 표에 주인이 있으면 주인이 나인지, 없으면(적·세계 단위) 참. `GameData.setPokemonCaught` 첫 줄 훅이 상대 포켓몬이면 "봤음"만 남기고 끝낸다. 종 번호만 받는 쓰기(`updateSpeciesDexIvs`, `addStarterCandy`, `setEggMoveUnlocked`, `unlockSpeciesNature`, `abilityAttr`)는 호출부에서 같은 함수로 막는다.
- 포획(`coop-capture.ts`): 잡는 순간(`AttemptCapturePhase.catch` 첫 줄) 적 포켓몬 id에 던진 사람을 주인으로 등록한다. 파티에 들어갈 때 같은 id를 쓰므로(`addToParty`가 데이터 원본의 id를 이어받음) 그 뒤의 계정 쓰기가 모두 주인 기준이 된다. ME의 `catchPokemon`도 같은 방식으로 고른 사람(그 웨이브 순번)을 주인으로 하고 3마리 한도·놓아주기 결정을 공유한다.
- 소유권 승계(`coop-ownership` 이용): Weird Dream(변신)과 Global Trade System(교환)은 새 포켓몬 객체를 만들므로 이전 포켓몬 주인을 그대로 넘긴다.
- 알 부화 보류(`coop-account.ts`): `EggLapsePhase.start` 첫 줄 훅. 협동이면 걸음 수만 줄이고 부화하지 않는다.
- 협동 클리어와 통계(`coop-records.ts`): `GameOverPhase`의 클래식 승리 분기 대신 협동 클리어 처리, `SelectStarterPhase`의 클래식 시작 횟수 대신 협동 시작 횟수, `achvs.COOP_VICTORY`.
- 협동 기록(`coop-records.ts`): 런 히스토리 항목에 협동 블록(계정 스냅샷 제외, 내 역할 포함)을 붙이고, 런 히스토리 화면은 솔로/협동 탭으로 나눠 보여 준다. 게임 통계 화면에 협동 행 2개.

**Tech Stack:** TypeScript, vitest(jsdom), `GameManager`, `CoopTestPartner`, 기록-재생 도구(`test/utils/coop-replay.ts`), Go 1.24(`go test`, `go vet`)

**Spec:** `docs/superpowers/specs/2026-10-12-coop-mode-design.md` 3.3(포획 소유), 3.7(계정과 진행도, 협동 클리어, 알 부화 보류, 협동 기록), 3.10(ME에서 얻은 포켓몬, Weird Dream·Training Session 주인 계정 기록, GTS 소유), 4.4 행(협동 기록, 클리어 처리, 도감과 진행도), 6장 9·10번

**앞 계획:** 2단계 조사표(7단계로 넘긴 계정 쓰기 행), 3단계 메모 12번(`classicSessionsPlayed`), 4단계 메모 17번(포획 "잡음" 기록), 5단계 메모 19번(ME 소유권·3마리 한도, Weird Dream·Training Session 주인 계정), 6단계 메모 6·16번(협동 클리어 처리, 보상 화면 순번이 아닌 쪽의 버튼, 끊김 배너가 스타터 선택 화면 뒤에 가려짐)

## Global Constraints

- **솔로 동작은 그대로다.** 모든 훅은 `coopSession`이 `null`이면 기존 코드와 같은 값을 내고 같은 함수를 부른다.
- **각 클라이언트는 자기 계정만 쓴다.** 상대 계정 데이터는 런 시작 스냅샷(시뮬레이션용)으로만 읽고, 바꾸거나 보내지 않는다.
- **계정 쓰기는 시뮬레이션을 바꾸지 않는다.** 시드 RNG를 쓰지 않고, 공유 상태(파티, 소유권, 돈, 아이템)를 클라이언트마다 다르게 바꾸지 않는다. 메시지 창(새 스타터 추가 등)처럼 한쪽에만 생기는 연출은 상태 해시와 무관해야 한다.
- 코어(`src/` 중 `src/coop/` 바깥) 변경은 훅 호출과 import, 조건 한 줄로 제한한다. 업적 목록과 통계 필드처럼 데이터 정의가 필요한 곳은 한 줄씩 더한다.
- 번역 키는 `locales` 서브모듈에 넣지 않고 `coopText`의 기본 문구(한국어/영어)를 쓴다. `assets` 서브모듈은 건드리지 않는다.
- 테스트당 `GameManager` 하나, "타이틀을 지난 뒤 세션을 연다", 대기는 `waitForCoop`.

## Review Focus

1. **주인 계정에만 쌓이는가**: 게스트가 잡은 포켓몬은 게스트 계정에만 "잡음"·개체값·캔디가 쌓이고 호스트 계정에는 "봤음"만 남는다(그 반대도). 진화·우정 캔디·민트·Training Session·Weird Dream도 같다. → Task 1~4.
2. **양쪽 해시가 같은가**: 게스트가 잡은 포켓몬이 진화하고 캔디가 쌓이는 런을 호스트·게스트로 재생해 해시와 입력이 같다. → Task 10.
3. **ME 포켓몬 소유와 한도**: ME에서 얻은 포켓몬은 고른 사람 것이고, 고른 사람이 3마리면 놓아주기 결정을 고른 사람만 하고 상대는 같은 결과를 적용한다. 변신·교환한 포켓몬은 이전 주인 것이다. → Task 4.
4. **클래식 클리어로 세지 않는가**: 협동 승리에서 클래식 업적·승리 횟수·리본·바우처·언락이 없고 "협동 클리어" 업적과 협동 승리 횟수만 오른다. 협동 시작은 클래식 시작 횟수를 올리지 않는다. → Task 6.
5. **기록이 섞이지 않는가**: 협동 런은 런 히스토리의 협동 탭에만, 솔로 런은 솔로 탭에만 보인다. → Task 7.

---

## 조사 결과

### A. 런 중 계정 쓰기 (2단계 조사표 "7단계" 행을 자세히)

| 쓰기 | 위치 | 협동 규칙 | 훅 |
|---|---|---|---|
| 적 "봤음" | `encounter-phase.ts` `setPokemonSeen` | 둘 다 봄(양쪽이 같은 적을 봄) | 없음 |
| 포획 "잡음"·통계·캔디·특성·성격 | `attempt-capture-phase.ts` `catch` → `setPokemonCaught` | 던진 사람 계정만, 상대는 "봤음"(스펙 3.7) | `catch` 첫 줄에서 주인 등록, `setPokemonCaught` 첫 줄 |
| 포획 개체값 | `catch`의 `updateSpeciesDexIvs` | 던진 사람만 | 호출부 조건 |
| 진화·폼 변경 "잡음" | `pokemon.ts` `evolve`, `changeForm` 계열 → `setPokemonCaught(this, false)` | 주인만, 상대는 "봤음" | `setPokemonCaught` 훅이 처리 |
| 진화 개체값 | `pokemon.ts` `evolve`의 `updateSpeciesDexIvs` | 주인만 | 호출부 조건 |
| 우정 캔디·최대 우정 업적·리본 | `pokemon.ts` `addFriendship` | 주인만(포켓몬의 친밀도 자체는 공유 상태라 그대로) | 계정 쓰기 직전 한 줄 |
| 민트(성격 해금) | `modifier.ts` `PokemonNatureChangeModifier.apply` | 주인만 | 호출부 조건 |
| ME 포획/획득 | `encounter-pokemon-utils.ts` `catchPokemon` | 고른 사람(웨이브 순번) 소유, 그 계정만 | 첫 줄 주인 등록, 개체값 조건, 한도·결정 |
| Training Session | 개체값·잡음·성격·특성 해금 | 고른 포켓몬 주인만 | 호출부 조건 3곳 |
| Weird Dream | 개체값·잡음·캔디·알 기술 | 변신한 각 포켓몬 주인만 | 소유권 승계 + 호출부 조건 3곳 |
| 바우처·알 보상 | ME 보상, `modifier.ts` 바우처 | 두 계정 모두(스펙 3.7, 양쪽이 같은 코드를 돌므로 그대로) | 없음 |
| 업적 | `validateAchv` 각 지점 | 스펙 3.7 "그대로": 양쪽이 같은 사건을 보므로 각자 계정에 그대로(최대 우정 업적만 우정 계정 쓰기와 함께 주인) | 없음 |
| 알 부화 | `EggLapsePhase` | 협동 중 보류(스펙 3.7) | `start` 첫 줄 |
| 통계 `battles`, `pokemonDefeated`, `highestLevel` 등 | 각 단계 | 둘 다 겪은 일이라 그대로 | 없음 |

- `addToParty`는 적 포켓몬을 데이터 원본으로 새 `PlayerPokemon`을 만들고 id를 이어받는다. 그래서 잡는 순간 적 id에 주인을 등록하면 `setPokemonCaught(적)`부터 파티 이후까지 같은 주인이 보인다. 놓아준(파티에 넣지 않은) 경우에도 등록은 남지만 `countOwnedBy`는 파티만 세므로 영향이 없다(4단계 메모 8번과 같음).
- 상대 포켓몬의 `setPokemonCaught`는 `setPokemonSeen(pokemon, false)`만 한다: 그 폼·이로치를 봤음으로 남기되 "본 횟수"는 늘리지 않는다(적으로 만났을 때 이미 셈).
- 새 스타터 추가 문구(`addedAsAStarter`)와 캔디 표시는 주인 클라이언트에서만 뜬다. UI 대기일 뿐 공유 상태를 바꾸지 않는다.

### B. 협동 클리어 (스펙 3.7, 6단계 메모 6번)

| 지점 | 파일 | 솔로 | 협동 |
|---|---|---|---|
| 클래식 승리 분기 | `game-over-phase.ts` `doGameOver` | `CLASSIC_VICTORY`, `UNEVOLVED_CLASSIC_VICTORY`, `sessionsWon++`, 첫 클리어 리본·바우처, 리본 | `awardCoopVictory()`가 `COOP_VICTORY` 업적과 `coopSessionsWon++`만 하고 분기를 건너뜀 |
| 새 클리어 | `handleGameOver` | `newclear` 결과 | 협동은 `false`로 진행 → `handleUnlocks`(엔드리스 등 언락)·첫 클리어 바우처 없음 |
| 시작 횟수 | `select-starter-phase.ts` `initBattle` | `classicSessionsPlayed++` | `coopSessionsPlayed++`(클래식 횟수는 그대로) |
| 엔딩 연출 | 같은 파일 | 클래식 엔딩 대화·엔드 카드 | 그대로(보상과 무관) |

- `GameStats`에 `coopSessionsPlayed`, `coopSessionsWon`을 더한다(필드 2개와 생성자 2줄). 백엔드는 `gameStats`를 형식 없는 값으로 저장하므로 새 키가 그대로 남는다(아래 D).
- 업적 `COOP_VICTORY`: 점수 250(클래식 클리어와 같은 급, 스펙 3.7), 아이콘 `linking_cord`(연결의끈), 조건 없음. 이름·설명은 번역 키가 없으면 `coopText` 기본 문구.

### C. 협동 기록 (스펙 3.7, 4.4)

- 런 히스토리는 각 클라이언트 `localStorage`에만 있다(`GameData.saveRunHistory`). 그대로 쓴다. 게스트도 자기 기록을 남긴다.
- 항목: `GameOverPhase.getRunHistoryEntry`에 협동 블록을 더한다. 두 계정 스냅샷(도감 목록 등)은 비우고(기록 크기), 내 역할(`localRole`)을 넣는다. 파트너 이름은 `participants`에서 상대 역할로 찾는다. 파티는 6마리 전체가 이미 들어 있다(양쪽 파티).
- 화면: 런 히스토리에 탭 2개. 기본은 솔로 탭(협동 항목 제외), 좌/우 키로 협동 탭(협동 항목만). 오른쪽 위에 탭 이름, 협동 항목의 모드 줄은 "협동 - 파트너 이름 - 웨이브 N", 파티 아이콘은 내 포켓몬 먼저.
- 통계 화면: "협동 런", "협동 클리어" 행(일일 런 다음).

### D. 백엔드 (rogueserver)

- `defs.SystemSaveData.GameStats`는 `interface{}`라 새 키(`coopSessionsPlayed`, `coopSessionsWon`)가 그대로 저장된다. `AchvUnlocks`는 `map[string]int`라 `COOP_VICTORY`도 그대로.
- `UpdateAccountStats`는 아는 열만 `accountStats` 표에 쓰고 모르는 키는 건너뛴다. 단 값이 숫자가 아니면 저장 전체를 실패시킨다. 협동 통계는 숫자다.
- 변경: 동작은 바꾸지 않고, DB 없이 시험할 수 있게 순수 함수 두 개를 떼어 낸다(`encodeSystemSaveData`/`decodeSystemSaveData`, `accountStatColumns`). Go 테스트: 협동 통계·업적이 있는 시스템 세이브 JSON → gob 왕복 후 같음, 협동 통계 키는 `accountStats` 열에서 빠지고 아는 열은 그대로.

### E. 7단계로 넘어온 정리

| 인계 | 처리 |
|---|---|
| 보상 화면에서 순번이 아닌 사람의 "세이브 후 나가기"(6단계 메모 16번) | 순번이 아닌 쪽이 보상 화면을 보는 동안 중개자에 대기 하나를 잡아 대기 버튼이 뜨게 한다(`holdWait`). 화면이 닫히면 놓는다 |
| 끊김 배너가 스타터 선택 화면 뒤에 가려짐 | 끊김·종료 문구는 다른 화면 앞에 그린다(`showCoopBanner(text, { onTop: true })`) |
| 재동기화(호스트 상태 전송), 대기 버튼·배너의 세밀한 배치 | 크다. 이번 단계에서 하지 않고 남긴다 |

---

## 파일 구조

```
src/coop/
  coop-account.ts        계정 기록 규칙, 상대 포켓몬 "봤음", 소유권 승계, 알 부화 보류
  coop-records.ts        협동 클리어, 협동 통계, 런 히스토리 협동 블록·탭, 통계 행, 업적 문구
  coop-capture.ts        (수정) 잡는 순간 주인 등록, ME 포획 주인·한도·결정
  coop-input-broker.ts   (수정) holdWait
  coop-reward.ts         (수정) 순번이 아닌 쪽의 대기
  coop-banner.ts, coop-exit.ts, coop-text.ts, coop-protocol.ts (수정)
src/ (훅)
  system/game-data.ts, system/game-stats.ts, system/achv.ts, phases/attempt-capture-phase.ts,
  phases/egg-lapse-phase.ts, phases/game-over-phase.ts, phases/select-starter-phase.ts, field/pokemon.ts,
  modifier/modifier.ts, data/mystery-encounters/utils/encounter-pokemon-utils.ts,
  data/mystery-encounters/encounters/{training-session,weird-dream,global-trade-system}-encounter.ts,
  ui/handlers/run-history-ui-handler.ts, ui/handlers/game-stats-ui-handler.ts
test/tests/coop/
  coop-account.test.ts, coop-account-replay.test.ts, coop-encounter-pokemon.test.ts, coop-egg.test.ts,
  coop-clear.test.ts, coop-records.test.ts
rogueserver/
  db/savedata.go, db/account.go (순수 함수 분리), db/savedata_test.go, db/account_test.go
```

---

## Task 1: 계정 기록 규칙과 상대 포켓몬 "봤음"

**Files:** Create `coop-account.ts`; Modify `game-data.ts`(`setPokemonCaught` 첫 줄); Test `coop-account.test.ts`

- `coopCreditsLocalAccount(pokemon: Pokemon): boolean`
- `recordCoopPartnerCatch(gameData, pokemon): Promise<boolean> | null` — 상대 포켓몬이면 `setPokemonSeen(pokemon, false)` 후 `false`, 아니면 `null`

- [x] **Step 1: 실패 테스트** — 솔로는 늘 참. 협동(호스트 클라이언트): 호스트 소유 참, 게스트 소유 거짓, 주인 없는 적 참. 게스트 소유 포켓몬의 `setPokemonCaught`는 `caughtAttr`·`caughtCount`·캔디를 바꾸지 않고 `seenAttr`만 더한다. 내 포켓몬은 솔로처럼 잡음.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): credit a pokemon's catch to its owner's account only`

## Task 2: 포획

**Files:** `coop-capture.ts`, `attempt-capture-phase.ts`(두 줄); Test `coop-account.test.ts`

- [x] **Step 1: 실패 테스트** (GameManager + 가상 파트너) — 호스트 클라이언트에서 게스트가 마스터볼로 잡으면 호스트 계정의 그 종 `caughtCount`·개체값이 그대로, `seenAttr`는 있음. 게스트 클라이언트에서 같은 포획이면 게스트 계정에 "잡음". 호스트 자신이 잡으면 호스트 계정에 "잡음".
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): record catches on the thrower's account`

## Task 3: 진화, 우정 캔디, 민트

**Files:** `pokemon.ts`(두 곳), `modifier.ts`(한 곳); Test `coop-account.test.ts`

- [x] **Step 1: 실패 테스트** — 상대 포켓몬의 `addFriendship`은 친밀도는 올리되 내 `starterData` 캔디 진행·캔디가 그대로, 내 포켓몬은 오름. 상대 포켓몬이 진화하면 내 계정에 진화형 "잡음"·개체값이 없고 "봤음"만. 상대 포켓몬에 민트를 쓰면 내 성격 해금이 없다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): keep evolution, candy and mint records on the owner's account`

## Task 4: ME에서 얻은 포켓몬과 ME 계정 쓰기

**Files:** `coop-capture.ts`, `coop-account.ts`, `encounter-pokemon-utils.ts`(`catchPokemon`), `training-session-encounter.ts`, `weird-dream-encounter.ts`, `global-trade-system-encounter.ts`; Test `coop-encounter-pokemon.test.ts`

- `registerCoopEncounterCatch(pokemon)`: 그 웨이브 순번(`pickerForWave`)을 주인으로 등록
- `isEncounterCatchRosterFull()`: 솔로는 파티 6마리, 협동은 고른 사람 3마리
- `beginCoopEncounterCatchDecision()`: 포획과 같은 결정(`choice capture`), 주인은 역할로
- `inheritCoopOwner(previous, next)`

- [x] **Step 1: 실패 테스트**
  - `catchPokemon`(호스트 순번 웨이브): 얻은 포켓몬은 호스트 소유, 호스트 계정에 "잡음". 게스트 순번 웨이브에서 호스트 클라이언트는 "봤음"만.
  - 고른 사람이 3마리면: 고른 사람 클라이언트는 놓아주기 질문, 상대 클라이언트는 결정을 기다려 같은 결과(놓아줌 → 같은 자리에 추가, 또는 안 넣음).
  - 상대가 3마리여도 고른 사람이 3마리 미만이면 바로 들어간다(파티 6마리 미만).
  - GTS 교환·Weird Dream 변신 뒤의 새 포켓몬은 이전 포켓몬 주인 소유.
  - Training Session: 상대 포켓몬이면 내 계정의 성격 해금이 없다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): give pokemon from encounters to the player who chose`, `feat(coop): keep encounter records on the owner's account`

## Task 5: 알 부화 보류

**Files:** `coop-account.ts`, `egg-lapse-phase.ts`(첫 줄); Test `coop-egg.test.ts`

- [x] **Step 1: 실패 테스트** — 협동에서 웨이브를 이기면 남은 걸음이 1이던 알이 부화하지 않고(알 목록에 남음, `EggHatchPhase` 없음) 걸음은 줄어든다. 솔로는 부화한다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): hold egg hatches until the co-op run ends`

## Task 6: 협동 클리어와 협동 통계

**Files:** Create `coop-records.ts`; Modify `game-stats.ts`, `achv.ts`, `game-over-phase.ts`, `select-starter-phase.ts`; Test `coop-clear.test.ts`

- [x] **Step 1: 실패 테스트** — 협동 승리 `GameOverPhase`: `COOP_VICTORY`가 열리고 `coopSessionsWon`이 1, `CLASSIC_VICTORY`·`sessionsWon`·리본(`classicWinCount`)·언락·바우처 없음. 솔로 클래식 승리는 그대로. 협동 시작은 `coopSessionsPlayed`만 오르고 `classicSessionsPlayed`는 그대로. 업적 이름은 번역 키가 없으면 기본 문구. 새 통계가 시스템 세이브 왕복(`parseSystemData`)에 남는다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): count co-op clears apart from classic clears`

## Task 7: 협동 기록 탭과 통계 행

**Files:** `coop-records.ts`, `game-over-phase.ts`(항목 한 줄), `run-history-ui-handler.ts`(훅), `game-stats-ui-handler.ts`(행); Test `coop-records.test.ts`

- [x] **Step 1: 실패 테스트** — 협동 게임 오버의 런 히스토리 항목에 협동 블록(내 역할, 참가자, 소유권, 빈 계정 스냅샷)이 있다. 솔로 항목에는 없다. 런 히스토리 화면은 솔로 탭에서 협동 항목을 빼고, 좌/우로 바꾼 협동 탭에서는 협동 항목만, 모드 줄에 파트너 이름. 통계 화면에 협동 행 2개(기본 문구).
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): keep co-op runs in their own run history tab`

## Task 8: 백엔드 확인

**Files:** rogueserver `db/savedata.go`, `db/account.go`; Test `db/savedata_test.go`, `db/account_test.go`

- [x] **Step 1: 실패 테스트** — (순수 함수가 없어 컴파일 실패) 협동 통계·업적이 든 시스템 세이브가 gob 왕복 후 같다. `accountStatColumns`는 협동 통계 키를 빼고 아는 열과 바우처 열만 돌려준다. 숫자가 아닌 값은 오류.
- [x] **Step 2~4**, **Step 5: 커밋** — `test(savedata): keep co-op stats and achievements in system saves`

## Task 9: 인계 정리

**Files:** `coop-input-broker.ts`, `coop-reward.ts`, `coop-banner.ts`, `coop-exit.ts`; Test `coop-wait-button.test.ts`, `coop-exit.test.ts`

- [x] **Step 1: 실패 테스트** — 순번이 아닌 쪽 보상 화면에서 대기 버튼이 보이고 메뉴 키 두 번이면 세이브 후 나가기, 화면이 닫히면 버튼이 사라진다. 순번인 쪽에는 없다. 끊김 배너는 다른 화면 앞(UI 컨테이너 맨 위)에 있다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): offer save and quit to the player waiting on the reward screen`, `fix(coop): show the connection notice above other screens`

## Task 10: 기록-재생과 변이 확인

**Files:** Test `coop-account-replay.test.ts`

- [x] **Step 1** — 시나리오: 게스트가 첫 턴에 마스터볼로 잡고 두 웨이브를 진행(우정 캔디 포함). 호스트·게스트 해시와 입력이 같고, 호스트 계정에는 그 종이 "봤음"만, 게스트 계정에는 "잡음". 반대로 호스트가 잡는 시나리오도 같다.
- [x] **Step 2: 변이 확인** — `setPokemonCaught` 훅, 포획 주인 등록, 개체값 조건, 우정 캔디 조건, ME 주인 등록·한도, 소유권 승계, 알 부화 훅, 협동 클리어 분기, 시작 횟수, 런 히스토리 탭 필터, 대기 잡기를 하나씩 끄고 해당 테스트가 실패하는지 확인

## Task 11: 마무리

- [x] **Step 1:** `pnpm test test/tests/coop && pnpm typecheck && pnpm biome:ci && pnpm ls-lint`, 백엔드 `go test ./...`, `go vet ./...`
- [ ] **Step 2: 화면 확인 (선택, 하지 않음)** — 오프라인 두 창: 런 히스토리 협동 탭, 통계 화면 협동 행. 스크린샷 `coop-screens-stage7/`
- [x] **Step 3:** "구현 메모" 추가, 체크박스 갱신, 커밋 — `docs: mark co-op account progress plan progress`

---

## 구현 메모 (계획과 달라진 점)

구현하면서 정한 것과 새로 알게 된 부분이다. 8단계 이후 계획은 이 내용을 기준으로 작성한다.

1. **계정 기록 규칙(`coopCreditsLocalAccount`)**: 소유권 표에 주인이 있으면 주인이 나일 때만, 주인이 없으면 적(세계 단위)이라 참, 주인 없는 파티 포켓몬은 호스트 것으로 본다(4단계 규칙과 같음). 종 번호만 받는 `GameData` 함수(`updateSpeciesDexIvs`, `addStarterCandy`, `setEggMoveUnlocked`, `unlockSpeciesNature`, `abilityAttr`)는 안에서 포켓몬을 알 수 없어서 호출부에 조건을 달았다. 포켓몬을 받는 `setPokemonCaught`만 함수 첫 줄 훅으로 처리한다.
2. **상대 포켓몬은 "봤음"만 (설계자 판단)**: 상대 포켓몬의 `setPokemonCaught`는 `setPokemonSeen(pokemon, false)`만 한다. 그 폼·이로치는 봤음으로 남지만 본 횟수는 늘리지 않는다(적으로 만났을 때 이미 셈). 진화·폼 변경의 "잡음" 갱신도 같은 훅을 지난다.
3. **잡는 순간 주인 등록**: `AttemptCapturePhase.catch` 첫 줄에서 적 포켓몬 id에 던진 사람을 등록한다. `addToParty`가 같은 id를 이어받으므로 `setPokemonCaught(적)`부터 주인 기준이 된다. 놓아준 포켓몬의 등록은 남지만 `countOwnedBy`는 파티만 센다.
4. **업적은 그대로 (설계자 판단, 확인 필요)**: 스펙 3.7 "런 도중 업적은 각자 계정에 그대로"를 문자 그대로 따라, 포획·레벨·이로치 업적은 두 클라이언트가 같은 사건을 보고 각자 받는다. 상대가 전설을 잡아도 내 계정에 "전설 포획" 업적이 열린다. 예외는 최대 우정 업적(`MAX_FRIENDSHIP`)과 우정 리본으로, 우정 캔디와 같은 계정 쓰기 블록 안에 있어 주인만 받는다. 포획 업적도 던진 사람만 받게 하려면 `catch`·`catchPokemon`의 업적 4줄에 같은 조건을 달면 된다.
5. **통계 (설계자 판단)**: `pokemonCaught`·`pokemonHatched` 같은 포획 통계는 `setPokemonCaught` 안이라 주인만, `battles`·`pokemonDefeated`·`highestLevel`·`highestDamage` 등은 둘 다 겪은 일이라 그대로 둘 다 올린다.
6. **ME에서 얻은 포켓몬**: `catchPokemon`(Salesman, Uncommon Breed, Dancing Lessons, Absolute Avarice 등)은 첫 줄에서 그 웨이브 순번(ME 선택지를 고른 사람)을 주인으로 등록하고, "가득 참"을 고른 사람 3마리로 판정한다. 놓아주기 결정은 포획과 같은 `CoopCaptureDecision`(`choice capture`)을 쓴다(생성자가 포켓몬 id 대신 역할을 받도록 바꿈). 상대가 3마리여도 고른 사람에게 자리가 있으면 바로 들어간다.
7. **소유권 승계**: GTS 교환(두 선택지)과 Weird Dream 변신은 새 `PlayerPokemon`을 만들어 id가 바뀐다. 이전 포켓몬 주인을 그대로 넘긴다(`inheritCoopOwner`). 이전에는 새 포켓몬이 주인 없음 → 호스트 것으로 취급되어 3마리 배분이 깨졌다(5단계에서 놓친 부분). Weird Dream은 변신 목록을 만드는 곳(`getTeamTransformations`)에서 넘기므로 계정 기록(개체값·잡음·캔디·알 기술)도 주인 기준이 된다.
8. **알 부화 보류 (스펙과 다름, 확인 필요)**: `EggLapsePhase.start` 첫 줄에서 협동이면 남은 걸음만 1씩 줄이고(0 아래로는 안 내려감) 부화하지 않는다. 스펙은 "타이틀로 돌아갈 때 각자 부화"인데, 부화 연출(`EggHatchPhase`, 알 부화 화면)은 런 화면을 전제로 해서 타이틀에서 돌리기 어렵다. 대신 걸음이 다 된 알은 **다음 솔로 런에서 처음 이긴 웨이브**에 부화한다(원래 코드가 `hatchWaves < 1`인 알을 모두 부화시키므로 따로 할 일이 없음). 타이틀 부화가 꼭 필요하면 후속 과제.
9. **협동 클리어**: `GameOverPhase`의 클래식 분기 조건을 `isClassic && !awardCoopVictory()`로 바꿨다. 협동이면 `COOP_VICTORY` 업적과 `coopSessionsWon++`만 하고 클래식 업적·`sessionsWon`·첫 클리어 리본(`classicWinCount`)·리본을 건너뛴다. 협동은 `newclear` 대신 `false`로 진행해서 `handleUnlocks`(엔드리스·스플라이스드 엔드리스·미니 블랙홀·진화의휘석)와 첫 클리어 바우처도 없다. 엔딩 대화와 엔드 카드는 그대로 나온다. 두 클라이언트가 각자 자기 계정에 받는다.
10. **협동 클리어 업적**: `achvs.COOP_VICTORY`(목록 맨 끝, 점수 250 = 클래식 클리어와 같음, 아이콘 `linking_cord`(연결의끈), 조건 없음, 바우처 없음). 번역 키는 locales에 넣지 않고 `withCoopAchvText`가 인스턴스의 `name`/`description`을 `coopText`(한국어 "협동 챔피언" / 영어 "Co-op Champions")로 바꿔 준다(`achv.ts`가 `coop-text`만 import하므로 순환 import 없음).
11. **협동 통계 (설계자 판단)**: 협동 시작은 `classicSessionsPlayed` 대신 `coopSessionsPlayed`를 올린다(3단계 메모 12번의 결정). 이어하기는 솔로와 같이 세지 않는다. `GameStats`에 `coopSessionsPlayed`, `coopSessionsWon`을 더했고(필드 2개), 통계 화면에 "협동 런", "협동 클리어" 행을 일일 런 다음에 넣었다(`DisplayStat.label`로 번역 키 없이 문구 지정).
12. **협동 기록 탭**: 런 히스토리 항목에 협동 블록을 붙인다(계정 스냅샷의 도감·알 기술·언락 목록은 비워 크기를 줄이고, 내 역할 `localRole`을 더함). 런 히스토리 화면은 솔로 탭으로 열리고 좌/우 키로 협동 탭과 바꾼다. 오른쪽 위에 "< 솔로 기록 >"/"< 협동 기록 >", 협동 항목의 모드 줄은 "협동: 파트너 이름(8자까지) - 웨이브 N". 파티 아이콘은 6마리 전체(양쪽 파티)를 원래 순서로 보여 주고 주인 표시는 없다. 솔로와 협동 항목이 합쳐서 25개 한도를 나눠 쓴다. 테스트용 `MockText`에 `appendText`를 더했다(헤드리스에서 런 히스토리 항목을 만들기 위해).
13. **백엔드**: 동작 변경은 없다. `GameStats`가 형식 없는 값이라 새 통계 키가 그대로 저장되고, `accountStats` 표는 아는 열만 쓴다(모르는 키는 건너뜀, 숫자가 아니면 저장 전체가 실패하므로 협동 통계는 숫자). DB 없이 시험하려고 시스템 세이브 gob 인코드·디코드(`encodeSystemSaveData`/`decodeSystemSaveData`)와 열 고르기(`accountStatColumns`)를 순수 함수로 떼고 Go 테스트 3개를 더했다. 커밋 `197bb9f`.
14. **보상 화면 대기 버튼**: 순번이 아닌 쪽이 보상 화면을 여는 동안 중개자에 대기 하나를 잡는다(`holdWait`). 그래서 메뉴 키는 일반 메뉴 대신 "세이브 후 나가기"(두 번 누름)가 되고, 화면이 닫히면(그 `SelectModifierPhase`의 `end`) 놓는다. 순번이 아닌 쪽도 상점·파티 확인은 그대로 쓸 수 있다.
15. **끊김 배너**: 재접속 카운트다운과 종료 문구는 다른 화면 앞에 그린다(`showCoopBanner(text, false, true)`). 차례·핑 배너는 기존처럼 뒤에 둔다.
16. **결정론**: 계정 쓰기는 로컬 `gameData`만 바꾸고, 시뮬레이션은 런 시작 스냅샷을 읽으므로 해시에 영향이 없다. 새 스타터 추가 문구는 잡은 쪽 화면에만 뜨지만 상태는 같다. 기록-재생 `coop-account-replay.test.ts`: 게스트가 잡는 경우·호스트가 잡는 경우 각각 해시와 입력이 같고, 잡은 쪽 계정만 "잡음"·잡은 횟수 1, 상대는 "봤음"만, 우정 캔디 진행은 각 스타터 주인 계정에만 쌓인다.
17. **변이 확인**: `setPokemonCaught` 훅 → 5개, 잡는 순간 주인 등록 → 3개, 포획 개체값 조건 → 1개, 우정 조건 → 2개(재생 포함), 진화 개체값 → 1개, 민트 → 1개, ME 주인 등록 → 3개, ME 한도 → 3개, ME 개체값 → 1개(처음엔 0개라 테스트를 보강), GTS 승계 → 1개, Weird Dream 승계 → 1개, Training Session 성격 → 1개, 알 부화 훅 → 1개, 협동 클리어 분기 → 1개, 협동 `newclear=false` → 1개, 시작 횟수 → 1개, 기록 항목 → 2개, 탭 필터 → 1개, 보상 대기 → 2개, 배너 앞 → 1개 실패.
18. **시험하지 않은 것**: Training Session의 개체값·특성 해금 조건(성격 해금만 시험), Weird Dream의 알 기술 해금(캔디·잡은 횟수로 시험), 실제 두 창 화면 확인(이번 단계는 하지 않음, 런 히스토리 탭 글자 위치는 눈으로 보지 않았다), 실제 rogueserver(MariaDB)에 협동 통계 저장.
19. **남은 것 (후속)**: 타이틀에서 알 부화(8번), 포획 업적을 던진 사람만 받게 할지(4번), 재동기화(호스트 상태 전송), 런 히스토리 협동 항목에서 주인별 파티 구분, 대기 버튼과 배너의 세밀한 배치.
