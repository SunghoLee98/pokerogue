# 협동 모드 2단계: 결정론 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 각 Task는 실패하는 테스트 → 실패 확인 → 구현 → 통과 확인 → 커밋 순서로 진행한다.

**Goal:** 두 클라이언트가 같은 시드와 같은 입력으로 같은 결과를 내도록, 결과에 영향을 주는 시드 없는 난수와 로컬 계정 데이터 의존을 협동 중에만 걷어내고, 그것을 검증하는 상태 해시와 기록-재생 desync 테스트 도구를 만든다.

**Architecture:** 코어는 `src/coop/`의 얇은 접근자 두 종류만 부른다. (1) `coopRandInt`/`coopRandIntRange`(`coop-random.ts`): 솔로에서는 기존 `randInt`/`randIntRange`를 그대로 부르고, 협동에서는 시드 RNG(`randSeedInt`)를 쓴다. (2) 시뮬레이션 데이터 소스(`coop-sim-data.ts`): `getWorldSimData()`와 `getPokemonSimData(pokemonId)`가 `SimAccountData`를 돌려준다. 솔로에서는 `globalScene.gameData`를 그대로 감싼 어댑터, 협동에서는 `CoopSession`에 저장된 계정 스냅샷(세계 단위 → 호스트, 포켓몬 단위 → 소유자)이다. 그 위에 상태 해시(`coop-state-hash.ts`)와 체크섬 비교(`coop-desync.ts`)를 두고, 테스트 쪽에 `GameManager` 기반 기록-재생 도구(`test/utils/coop-replay.ts`)를 둔다.

**Tech Stack:** TypeScript, vitest(jsdom), 기존 `GameManager` 테스트 프레임워크

**Spec:** `docs/superpowers/specs/2026-10-12-coop-mode-design.md` 4.1(결정론적 락스텝), 4.4(코어 연결 지점), 5(테스트 전략)

**앞 계획:** `docs/superpowers/plans/2026-10-12-coop-01-transport-foundation.md` (로드맵 표와 "스펙과 다른 점": 한 프로세스에 게임 두 개를 띄울 수 없으므로 기록 후 재생 방식으로 검증한다)

## Global Constraints

- **솔로 동작은 바이트 단위로 같아야 한다.** `coopSession`이 `null`이면 모든 접근자는 기존 코드와 같은 함수를 같은 인자로 부른다. 솔로에서 시드 RNG 소비 순서가 바뀌면 안 된다(기존 시드 기반 테스트와 데일리 런 재현성이 깨진다).
- 코어(`src/` 중 `src/coop/` 바깥) 변경은 **호출 한 줄 교체와 import 한 줄**로 제한한다. 주변 코드는 리팩터링하지 않는다.
- 이 단계는 UI를 추가하지 않고, 협동 세션을 실제로 시작하는 경로(타이틀 메뉴, `start` 메시지 송수신)도 만들지 않는다. 세션은 테스트에서만 만든다(3단계에서 연결).
- 협동 세션이 있는데 필요한 계정 스냅샷이 없으면 로컬 `gameData`로 조용히 대체하지 않고 오류를 던진다. 조용한 대체는 desync를 숨긴다.
- 새 파일은 kebab-case, biome 통과(경고 포함), REUSE 기본 표기(`src/**/*.ts`, `test/**/*.ts`) 적용.

## Review Focus

1. **솔로 회귀**: 협동이 아닐 때 교체된 호출이 기존과 같은 값을 내는지. → Task 1 `matches randInt outside co-op`, Task 2 `wraps the local game data outside co-op`, Task 3 각 지점의 `solo` 테스트.
2. **다른 계정 데이터로도 같은 결과**: 게스트 계정의 trainerId/secretId, 해금, 알 기술이 호스트와 달라도 해시 순서가 같아야 한다. → Task 5 `guest replay with different account data matches the host hashes`.
3. **desync를 실제로 잡는가**: 접근자를 우회한 것과 같은 상황(잘못된 세계 데이터)을 넣으면 첫 불일치 지점(웨이브, 턴)을 보고해야 한다. → Task 5 `detects a divergence injected through wrong world data`.
4. **해시가 결과에 민감하고 연출에 둔감한가**: HP·상태이상·이로치·RNG 상태가 바뀌면 해시가 바뀌고, 전투 애니메이션 설정은 해시 순서를 바꾸지 않아야 한다. → Task 4 해시 테스트, Task 5 `move animation setting does not change the hashes`.

---

## 조사 결과

### A. 시드 없는 난수 (`randInt`, `randIntRange`, `randItem`, `randGauss`, `Math.random`)

| 위치 | 용도 | 결과 영향 | 처리 |
|---|---|---|---|
| `src/data/status-effect.ts` `generateRandomStatusEffect`, `getRandomStatusEffect`, `getRandomStatus` | 무작위 상태이상, 합체 시 두 상태이상 중 하나 선택(`pokemon.ts` `fuse`에서 호출) | 있음 | 이번 단계: `coopRandIntRange` |
| `src/battle.ts` `getRandomTrainerFunc` (`randInt(2)`, `randInt(3)`) | 악의 조직 조무래기의 성별, 더블 트레이너 여부 | 있음(트레이너 변종에 따라 파티 구성이 달라짐) | 이번 단계: `coopRandInt` |
| `src/data/mystery-encounters/encounters/global-trade-system-encounter.ts` (`randInt(4)` 2곳) | 교환으로 받은 포켓몬의 볼 종류 | 있음(세이브되는 포켓몬 상태) | 이번 단계: `coopRandInt` |
| `src/data/mystery-encounters/encounters/absolute-avarice-encounter.ts` (`randInt(2)` 12곳) | 나무열매 흔들림 트윈 방향 | 없음(연출) | 변경 없음 |
| `src/data/egg.ts` (`randInt(EGG_SEED…)`, `randInt(256)`) | 알 id, 등급 | 계정 단위. `executeWithSeedOffset(…, randomString(24))` 안에서 돌고 끝나면 RNG 상태를 되돌리므로 공유 RNG를 건드리지 않는다. 알은 각 계정이 따로 받는다(스펙 3.7) | 변경 없음 |
| `src/system/game-data.ts` (`trainerId`, `secretId`, `natureAttr` 기본값) | 계정 생성 | 계정 단위 | 데이터 소스(B)로 대응 |
| `src/battle-scene.ts` `reset` (`randomString(24)`로 `setSeed`) | 새 게임 시드 | 협동에서는 호스트가 `start`로 보낸 시드를 쓴다 | 3단계 |
| `src/animations.ts`, `src/phases/egg-hatch-phase.ts`, `src/field/pokemon-sprite-tera-sparkle-handler.ts`, `src/ui/**` (`randInt`, `randGauss`, `randItem`, `Math.random`) | 파티클, 타이틀, UI | 없음 | 변경 없음 |
| `src/field/pokemon.ts`, `src/data/pokemon-species.ts` (`Math.random` 임시 교체) | 팔레트 양자화 | 시드 RNG를 쓰지만 `executeWithSeedOffset` 안이라 상태를 되돌림 | 변경 없음 |
| `src/modifier/modifier-type.ts`, `src/battle-scene.ts`, `src/data/daily-seed/daily-run.ts`의 `randInt` | 지역 변수 이름일 뿐 값은 `randSeedInt` | 해당 없음 | 변경 없음 |

### B. 전투·생성·진화·인카운터 경로의 `globalScene.gameData` 읽기

| 위치 | 읽는 값 | 결과 영향 | 단위 | 처리 |
|---|---|---|---|---|
| `src/field/pokemon.ts` `trySetShiny` | `trainerId ^ secretId` | 있음(이로치면 변종 롤이 시드 RNG를 더 소비) | 세계(적, 인카운터 포켓몬) | 이번 단계: `getWorldSimData()` |
| `src/field/pokemon.ts` `getUnlockedEggMoves` | `starterData[종].eggMoves` | 있음(배울 수 있는 기술 → 기억버섯 보상 가중치) | 포켓몬 | 이번 단계: `getPokemonSimData(this.id)` |
| `src/data/balance/pokemon-evolutions.ts` `SPECIES_CAUGHT` 조건 | `dexData[종].caughtAttr` | 있음(진화 여부) | 포켓몬 | 이번 단계: `getPokemonSimData(pokemon.id)` |
| `src/data/pokemon-forms.ts` `getSpeciesDependentFormChangeCondition` | `dexData[종].caughtAttr` | 있음(큐레무·네크로즈마 폼 변경) | 포켓몬 | 이번 단계: `getPokemonSimData(p.id)` |
| `src/data/pokeball.ts` `getCriticalCaptureChance` | `getSpeciesCount(caught)` | 있음(크리티컬 포획 확률) | 세계(이번 단계). 던진 사람 기준이 맞는지는 4단계에서 정한다 | 이번 단계: `getWorldSimData()` |
| `src/modifier/init-modifier-pools.ts` `EVIOLITE`, `MINI_BLACK_HOLE` 가중치 | `isUnlocked` | 있음(보상 풀) | 세계 | 이번 단계: `getWorldSimData()` |
| `src/field/pokemon.ts` `tryPopulateMoveset` | `starterData[종].eggMoves` | 스타터 기술 검증 | 포켓몬(스타터) | 3단계: 스타터 페이로드가 기준(스펙 4.5). 이 시점엔 소유권이 아직 없다 |
| `src/phases/select-starter-phase.ts` `getDexAttrLuck(dexData…)` | 스타터 행운 | 스타터 | 3단계 |
| `src/phases/command-phase.ts` `checkCanUseBall` | `dexData`, `getStarterCount` | 볼 사용 가능 여부(입력 검증) | 입력한 사람 | 4단계: 원격 명령은 보낸 쪽에서 검증된 것으로 보고 재검증하지 않는다 |
| `src/data/mystery-encounters/encounters/training-session-encounter.ts` (`checkSpeciesNatureUnlocked`, `checkStarterAbilityIndexUnlocked`, `dexData`) | 선택지 라벨의 "(+)" 표시, 계정 쓰기 조건 | 없음(표시/계정) | 계정 | 7단계 |
| `src/data/mystery-encounters/encounters/weird-dream-encounter.ts` (`dexData` → 캔디, 알 기술 해금) | 계정 쓰기 조건 | 없음(계정) | 계정 | 7단계 |
| `src/phases/encounter-phase.ts` (`classicSessionsPlayed`, `getSeenDialogues`) | 최종보스 대사 | 없음(표시) | — | 변경 없음 |
| `src/phases/scan-ivs-phase.ts` (`dexData.ivs`) | 개체값 스캐너 표시 | 없음(표시) | — | 변경 없음 |
| `src/field/pokemon.ts` `getDexAttr` → `getFormAttr` | 폼 비트 계산(계정 값이 아닌 고정 계산) | 없음 | — | 변경 없음 |
| 그 밖의 쓰기(`setPokemonSeen/Caught`, `addStarterCandy`, `gameStats`, `voucherCounts`, `unlocks`, `achvUnlocks`) | 계정 진행도 쓰기 | 시뮬레이션 값은 바꾸지 않음 | 계정 | 7단계(소유자 기록) |

조사 명령: `grep -rn "gameData\b" src`(UI·system 제외 후 한 줄씩 확인), `grep -rn "randInt\|randIntRange\|randItem\|randGauss\|Math.random\|randomString(" src`.

### C. 설정에 따라 달라지는 시드 RNG 소비

| 설정 | 영향 |
|---|---|
| `enableMoveAnimations` (`battle-anims.ts`, `damage-anim-phase.ts`, `stat-stage-change-phase.ts`) | 애니메이션 쪽 난수는 시드 없는 `randInt`/`randGauss`뿐이라 공유 RNG를 소비하지 않는다. Task 5에서 설정을 바꿔도 해시가 같은지 확인한다 |
| `battleStyle`(교체 확인), `levelMoveConfirmation`(기술 배우기 확인) | 입력을 묻는지 여부다. 묻는 입력은 4단계에서 협동 입력으로 다룬다 |
| `expGainsSpeed`, `hideIvScanner`, `damageNumbersMode`, `moneyFormat` 등 | 표시만 바꾼다 |
| `battle-message-ui-handler.ts` `promptIvs`, `egg-gacha-ui-handler.ts` | `executeWithSeedOffset` 안이거나 런 밖이라 공유 RNG 상태를 바꾸지 않는다 |

### D. 남은 위험 (이번 단계에서 고치지 않음)

- **기간 한정 이벤트(`timedEventManager`)**: 이로치 배율, 이벤트 인카운터, 보상 배율이 벽시계(`new Date()`)로 정해진다. 두 클라이언트의 시계나 자정 경계가 다르면 desync가 날 수 있다. 3단계에서 호스트가 `start`에 활성 이벤트를 담아 보내고 협동 중에는 그 값을 쓰는 방식으로 다룬다.
- **게스트 계정 스냅샷 전달**: 이번 단계는 스냅샷 타입과 저장소만 만든다. 호스트 스냅샷은 `start.hostWorldData`, 게스트 스냅샷은 `starters` 메시지에 실어 보내는 것을 3단계에서 연결한다.

---

## 파일 구조

```
src/coop/
  coop-random.ts        coopRandInt, coopRandIntRange (협동이면 시드 RNG)
  coop-sim-data.ts      SimAccountData, 계정 스냅샷 생성, getWorldSimData, getPokemonSimData
  coop-state-hash.ts    captureCoopState, hashCoopState, computeCoopStateHash
  coop-desync.ts        CoopChecksum, findFirstDesync
  coop-protocol.ts      (수정) CoopAccountSnapshot, CoopWorldData 좁히기
  coop-session.ts       (수정) 역할별 계정 스냅샷 저장
test/tests/coop/
  coop-random.test.ts, coop-random-call-sites.test.ts,
  coop-sim-data.test.ts, coop-sim-data-call-sites.test.ts,
  coop-state-hash.test.ts, coop-desync.test.ts, coop-desync-replay.test.ts
test/utils/
  coop-replay.ts        GameManager 기반 기록-재생 실행기
```

---

### Task 1: 협동용 난수 접근자와 시드 없는 난수 교체

**Files:**
- Create: `src/coop/coop-random.ts`
- Modify: `src/data/status-effect.ts`(3곳), `src/battle.ts`(2곳), `src/data/mystery-encounters/encounters/global-trade-system-encounter.ts`(2곳)
- Test: `test/tests/coop/coop-random.test.ts`, `test/tests/coop/coop-random-call-sites.test.ts`

**Interfaces:**
- Consumes: `coopSession`(1단계), `randInt`/`randIntRange`/`randSeedInt`/`randSeedIntRange`(`#utils/common`)
- Produces:
  - `export function coopRandInt(range: number, min = 0): number` — `coopSession`이 없으면 `randInt(range, min)`, 있으면 `randSeedInt(range, min)`.
  - `export function coopRandIntRange(min: number, max: number): number` — 없으면 `randIntRange`, 있으면 `randSeedIntRange`.

- [ ] **Step 1: 접근자 실패 테스트** (`coop-random.test.ts`):
  - `matches randInt outside co-op`: `Math.random`을 `0.75`로 고정하면 `coopRandInt(4) === 3`, `coopRandIntRange(1, 6) === 5`이고 `Phaser.Math.RND.state()`가 바뀌지 않는다.
  - `uses the seeded RNG in co-op`: 세션을 두고 `Phaser.Math.RND.sow(["coop"])` 후 뽑은 값 열이, 같은 시드로 다시 `sow`한 뒤 `randSeedInt`로 뽑은 열과 같다. `Math.random`은 호출되지 않는다.
- [ ] **Step 2: 실패 확인** — Run: `pnpm test test/tests/coop/coop-random.test.ts` / Expected: FAIL, 모듈 없음
- [ ] **Step 3: `coop-random.ts` 구현** → 통과 확인
- [ ] **Step 4: 호출 지점 실패 테스트** (`coop-random-call-sites.test.ts`, `#utils/common` 네임스페이스에 `vi.spyOn`):
  - `status effects stay unseeded in solo`: 세션 없이 `getRandomStatus(a, b)` 호출 시 `randIntRange`가 불린다.
  - `status effects use the seeded RNG in co-op`: 세션이 있으면 `randSeedIntRange`가 불리고 `randIntRange`는 안 불린다. `getRandomStatusEffect`, `generateRandomStatusEffect`도 같다.
  - `evil team grunt variants use the seeded RNG in co-op` (GameManager): `getRandomTrainerFunc([TrainerType.ROCKET_GRUNT], true)()` 호출 시 세션이 있으면 `randInt`가 불리지 않는다. 세션이 없으면 `randInt(2)`, `randInt(3)`이 불린다.
  - `GTS wonder trade picks the ball with the seeded RNG in co-op` (GameManager, 기존 GTS 테스트 구성): `randInt`를 `3`, `randSeedInt`를 `1`로 고정하고 옵션 2를 끝까지 진행하면 세션이 있을 때 받은 포켓몬 `pokeball === 1`, 세션이 없을 때 `3`.
- [ ] **Step 5: 실패 확인** — 세션이 있어도 `randInt`가 불려 FAIL
- [ ] **Step 6: 코어 7곳을 `coopRandInt`/`coopRandIntRange`로 교체**(import 한 줄 + 호출 교체만) → 통과 확인, 기존 `test/tests/mystery-encounter/encounters/global-trade-system-encounter.test.ts`도 통과
- [ ] **Step 7: 커밋** — `feat(coop): seed result-affecting randomness in co-op`

---

### Task 2: 시뮬레이션 데이터 소스

**Files:**
- Create: `src/coop/coop-sim-data.ts`
- Modify: `src/coop/coop-protocol.ts`, `src/coop/coop-session.ts`
- Test: `test/tests/coop/coop-sim-data.test.ts`

**Interfaces:**
- Produces (`coop-protocol.ts`, 전송 형식이므로 JSON으로 안전한 값만):
  ```ts
  export interface CoopAccountSnapshot {
    trainerId: number;
    secretId: number;
    /** caughtAttr가 0이 아닌 종 */
    caughtSpecies: number[];
    /** 루트 종 → starterData eggMoves 비트(0이 아닌 것만) */
    eggMoves: Record<number, number>;
    /** isUnlocked가 true인 Unlockables (오버라이드 포함) */
    unlocks: number[];
  }
  export type CoopWorldData = CoopAccountSnapshot;
  ```
- Produces (`coop-session.ts`): `setAccountSnapshot(role: CoopRole, snapshot: CoopAccountSnapshot): void`, `getAccountSnapshot(role: CoopRole): CoopAccountSnapshot` — 없으면 `Error("missing co-op account snapshot for <role>")`.
- Produces (`coop-sim-data.ts`):
  - `export interface SimAccountData { readonly trainerId: number; readonly secretId: number; isSpeciesCaught(speciesId: SpeciesId): boolean; getCaughtSpeciesCount(): number; getEggMoveBits(rootSpeciesId: SpeciesId): number; isUnlocked(unlockable: Unlockables): boolean; }`
  - `export type SimGameDataSource = Pick<GameData, "trainerId" | "secretId" | "dexData" | "starterData" | "getSpeciesCount" | "isUnlocked">`
  - `export function createAccountSnapshot(gameData: SimGameDataSource): CoopAccountSnapshot`
  - `export function getWorldSimData(gameData: SimGameDataSource = globalScene.gameData): SimAccountData` — 솔로: `gameData`를 그대로 감싼 어댑터(`!!dexData[s].caughtAttr`, `getSpeciesCount(d => !!d.caughtAttr)`, `starterData[s].eggMoves`, `isUnlocked(u)`). 협동: 호스트 스냅샷.
  - `export function getPokemonSimData(pokemonId: number, gameData = globalScene.gameData): SimAccountData` — 솔로: 위와 같음. 협동: `ownership.get(pokemonId)`의 스냅샷, 소유자가 없으면(적, 인카운터 포켓몬) 호스트 스냅샷.

- [ ] **Step 1: 실패 테스트** — 가짜 `SimGameDataSource`로:
  - `wraps the local game data outside co-op`: trainerId/secretId, `isSpeciesCaught`, `getCaughtSpeciesCount`, `getEggMoveBits`, `isUnlocked`가 가짜 데이터와 같은 값.
  - `snapshots the account`: `createAccountSnapshot`이 잡은 종, 0이 아닌 알 기술, 해금 목록을 담고 `JSON.parse(JSON.stringify(s))`와 같다.
  - `reads world data from the host snapshot in co-op`: 게스트 세션에서 로컬 가짜 데이터와 다른 호스트 스냅샷을 넣으면 `getWorldSimData()`가 호스트 값을 낸다.
  - `reads pokemon data from the owner snapshot in co-op`: id 1 호스트, id 2 게스트 소유일 때 `getPokemonSimData(2).getEggMoveBits(s)`는 게스트 값, 소유자 없는 id 99는 호스트 값.
  - `throws when a snapshot is missing`: 세션만 있고 스냅샷이 없으면 `getWorldSimData()`가 `missing co-op account snapshot for host`로 throw.
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인** (`pnpm test test/tests/coop`)
- [ ] **Step 5: 커밋** — `feat(coop): add simulation data source`

---

### Task 3: 코어 읽기 지점을 데이터 소스로 교체

**Files:**
- Modify: `src/field/pokemon.ts`(`trySetShiny`, `getUnlockedEggMoves`), `src/data/balance/pokemon-evolutions.ts`, `src/data/pokemon-forms.ts`, `src/data/pokeball.ts`, `src/modifier/init-modifier-pools.ts`(2곳)
- Test: `test/tests/coop/coop-sim-data-call-sites.test.ts` (GameManager)

**Interfaces:** Consumes Task 2의 `getWorldSimData`, `getPokemonSimData`, `CoopSession.setAccountSnapshot`

- [ ] **Step 1: 실패 테스트** — 각 테스트는 로컬 `gameData`와 세션 스냅샷이 다른 답을 내도록 꾸민다:
  - `rolls enemy shininess with the host trainer id`: 적 포켓몬 id에서 `F`를 구해 호스트 스냅샷을 `trainerId = F, secretId = 0`(이로치), 로컬을 `trainerId = F ^ 0x8000`(이로치 아님)으로 두면 세션이 있을 때 `trySetShiny() === true`, 없을 때 `false`.
  - `uses the owner's egg moves`: 게스트 소유 플레이어 포켓몬의 `getLearnableLevelMoves()`가 게스트 스냅샷의 알 기술을 담고 로컬 `starterData`의 알 기술은 담지 않는다.
  - `checks species-caught evolutions against the owner's dex`: 깨비물거미(`KARRABLAST`)의 `SPECIES_CAUGHT` 조건이 소유자 스냅샷 기준으로 판정된다.
  - `checks species-dependent form changes against the owner's dex`: `getSpeciesDependentFormChangeCondition(SpeciesId.RESHIRAM)`의 조건이 소유자 스냅샷 기준.
  - `uses the host dex count for critical captures`: 호스트 스냅샷의 잡은 종 수가 801이고 로컬이 0이면 `getCriticalCaptureChance(255)`가 세션 유무에 따라 다르다(세션 있으면 2.5배 쪽).
  - `uses host unlocks for the master reward pool`: `MINI_BLACK_HOLE` 가중치 함수가 호스트 스냅샷 해금 기준으로 `1`, 세션 없으면 로컬 기준 `0`.
- [ ] **Step 2: 실패 확인** — 세션이 있어도 로컬 값이 쓰여 FAIL
- [ ] **Step 3: 교체** — 각 지점에서 `globalScene.gameData.X`를 접근자 호출 한 줄로 바꾼다. 예: `const E = getWorldSimData().trainerId ^ getWorldSimData().secretId;` 대신 `const { trainerId, secretId } = getWorldSimData();` 한 줄 + 기존 식 유지.
- [ ] **Step 4: 통과 확인** — 새 테스트와 관련 기존 테스트(`test/tests/evolutions`, `test/tests/items/eviolite.test.ts`, `test/tests/moves/fusion-flare-bolt.test.ts` 등 교체 지점을 지나는 것) 통과
- [ ] **Step 5: 커밋** — `feat(coop): read simulation account data through the data source`

---

### Task 4: 상태 해시와 체크섬 비교

**Files:**
- Create: `src/coop/coop-state-hash.ts`, `src/coop/coop-desync.ts`
- Test: `test/tests/coop/coop-state-hash.test.ts`, `test/tests/coop/coop-desync.test.ts`

**Interfaces:**
- Produces (`coop-state-hash.ts`):
  - `export interface CoopPokemonState { id; speciesId; formIndex; level; hp; status; shiny; variant; fusionSpeciesId; moves: [moveId, ppUsed][] }` (모두 number/boolean)
  - `export interface CoopStateSnapshot { wave; turn; money; rngState: string; battleSeed: string; battleRngState: string | null; playerParty: CoopPokemonState[]; enemyParty: CoopPokemonState[]; playerField: number[]; enemyField: number[]; modifiers: [string, number][]; enemyModifiers: [string, number][]; weather: number; terrain: number }`
  - `export function captureCoopState(scene: BattleScene = globalScene): CoopStateSnapshot`
  - `export function hashCoopState(state: CoopStateSnapshot): string` — 정해진 키 순서의 JSON 문자열에 64비트 FNV-1a(BigInt 없이 32비트 두 개)를 적용해 16자리 16진수.
  - `export function computeCoopStateHash(scene = globalScene): string`
- Produces (`coop-desync.ts`):
  - `export type CoopChecksum = Omit<Extract<CoopMessage, { t: "checksum" }>, "t">` (`{ wave; turn; hash }`)
  - `export interface CoopDesync { index: number; expected: CoopChecksum | undefined; actual: CoopChecksum | undefined }`
  - `export function findFirstDesync(expected: readonly CoopChecksum[], actual: readonly CoopChecksum[]): CoopDesync | null` — 같은 위치의 wave·turn·hash가 하나라도 다르거나 길이가 다르면 첫 위치를 돌려준다.

- [ ] **Step 1: 실패 테스트**
  - `coop-desync.test.ts`: `returns null for identical sequences`, `reports the first differing checkpoint`, `reports a missing checkpoint when lengths differ`.
  - `coop-state-hash.test.ts` (순수): `hashes equal states equally`(키 순서가 다른 같은 객체도 같은 해시), `changes when hp, status, shininess or rng state changes`, `is a 16 character hex string`.
  - `coop-state-hash.test.ts` (GameManager, 더블 배틀 시작 후): `captures both fields and parties`(필드 id 2개씩, 파티 길이), `changes after a turn that deals damage`(턴 전후 해시가 다름), `is stable when nothing happens`(연속 두 번 계산이 같음).
- [ ] **Step 2: 실패 확인** → **Step 3: 구현** → **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `feat(coop): add state hash and checksum comparison`

---

### Task 5: 기록-재생 desync 테스트 도구와 시나리오

**Files:**
- Create: `test/utils/coop-replay.ts`, `test/tests/coop/coop-desync-replay.test.ts`

**Interfaces:**
- Consumes: `GameManager`, `CoopSession`, `createLoopbackPair`, `CoopAccountSnapshot`, `computeCoopStateHash`, `findFirstDesync`
- Produces (`test/utils/coop-replay.ts`):
  - `export interface CoopReplayCommand { moveId: MoveId; target: BattlerIndex }`
  - `export interface CoopReplayInput extends CoopReplayCommand { by: CoopRole; wave: number; turn: number }`
  - `export interface CoopReplayLog { inputs: CoopReplayInput[]; checksums: CoopChecksum[] }`
  - `export function applyAccountSnapshot(gameData: GameData, snapshot: CoopAccountSnapshot): void` — 테스트용. 로컬 계정을 스냅샷 내용으로 맞춘다.
  - `export async function runCoopReplay(game: GameManager, options: { role: CoopRole; accounts: Record<CoopRole, CoopAccountSnapshot>; worldData?: CoopAccountSnapshot; localCommand: (wave: number, turn: number) => CoopReplayCommand; remoteLog?: CoopReplayLog; waves: number; seed: string; species: [SpeciesId, SpeciesId] }): Promise<CoopReplayLog>`
    - 로컬 `gameData`를 `accounts[role]`로 맞추고, 세션을 만들어 `host`·`guest` 스냅샷을 넣는다(`worldData`가 있으면 호스트 자리에 그 값을 넣어 잘못된 세계 데이터를 흉내 낸다). 파티 0번은 호스트, 1번은 게스트 소유로 등록한다.
    - 필드 0은 호스트, 필드 1은 게스트가 명령한다. 로컬 역할의 명령은 `localCommand`에서, 상대 명령은 `remoteLog`가 있으면 거기서 같은 (wave, turn, by)를 찾아 쓰고(없으면 throw), 없으면(호스트 기록 실행) 상대 몫도 `localCommand`의 짝인 시나리오 함수에서 받는다.
    - 매 턴 끝(`TurnEndPhase` 이후)과 매 웨이브 시작(새 웨이브 첫 `CommandPhase`)에 `computeCoopStateHash()`를 기록한다.
- 시나리오 공통: 더블 배틀, 플레이어 레벨 100, 적 기술 `SPLASH`, 트레이너 웨이브 끔, 이로치 정규화 끔(`trySetShiny`가 실제로 trainerId를 쓰도록), 웨이브 2개.

- [ ] **Step 1: 실패 테스트** (`coop-desync-replay.test.ts`):
  - `host run is reproducible`: 같은 입력으로 호스트 실행을 두 번 하면 체크섬 열이 같고 길이가 3 이상이며 웨이브 2개를 지난다.
  - `guest replay with different account data matches the host hashes`: 게스트 계정은 trainerId/secretId가 첫 적을 이로치로 만드는 값(호스트 기록의 첫 적 id로 계산), `EVIOLITE`·`MINI_BLACK_HOLE` 해금, 다른 알 기술. 게스트 실행의 체크섬 열이 호스트 기록과 같다(`findFirstDesync === null`).
  - `detects a divergence injected through wrong world data`: 같은 게스트 실행에서 `worldData`로 게스트 자신의 스냅샷을 넣으면(세계 데이터 읽기가 로컬 계정으로 샌 상황) `findFirstDesync`가 첫 체크포인트(웨이브 1)를 가리킨다.
  - `move animation setting does not change the hashes`: 게스트 실행에서 `enableMoveAnimations`를 반대로 둬도 체크섬 열이 같다.
- [ ] **Step 2: 실패 확인** — `test/utils/coop-replay.ts` 없음
- [ ] **Step 3: 도구 구현** → **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `test(coop): add record-replay desync harness`

---

### Task 6: 마무리 확인

- [ ] **Step 1:** Run: `pnpm test test/tests/coop && pnpm typecheck && pnpm biome:ci && pnpm exec ls-lint && pnpm coop:server:test` / Expected: 통과(`pokemon-sprite.test.ts`의 기존 assets 관련 타입 오류 제외)
- [ ] **Step 2:** 교체 지점을 지나는 기존 테스트 묶음 실행(진화, 폼 변경, 볼, 보상, GTS, 상태이상) / Expected: 변경 전과 같은 결과
- [ ] **Step 3:** 이 문서에 "구현 메모" 추가, 체크박스 갱신, 커밋 — `docs: mark co-op determinism plan progress`
