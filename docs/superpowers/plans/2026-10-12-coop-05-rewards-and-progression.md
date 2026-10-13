# 협동 모드 5단계: 보상과 진행 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 각 Task는 실패하는 테스트 → 실패 확인 → 구현 → 통과 확인 → 커밋 순서로 진행한다. 로직을 테스트보다 먼저 쓰지 않는다(4단계 구현 메모 5번의 순서 위반을 반복하지 않는다).

**Goal:** 웨이브가 끝난 뒤의 모든 사람 입력을 두 클라이언트가 같은 결과로 처리한다. 무료 보상과 리롤은 그 웨이브 순번인 사람(홀수 호스트, 짝수 게스트)만 하고 상대는 "파트너가 고르는 중"을 보며 핑을 보낸다. 상점은 둘 다 사고, 호스트가 순번을 매겨 양쪽이 같은 순서로 한 번씩만 돈을 뺀다. 루어는 협동 보상 풀에서 빠진다. 바이옴 갈림길과 미스터리 인카운터(ME) 선택지도 같은 순번으로 고르고, ME에서 상대 포켓몬을 고르면 주인이 확인/거절한다. 협동에서 깨지는 ME 3개는 나오지 않는다. 기술 배우기·진화 취소·부활의 축복 같은 포켓몬 단위 선택은 그 포켓몬(또는 기술 사용자)의 주인이 한다. 기록-재생 테스트로 호스트와 게스트의 해시 순서가 같음을 보인다.

**Architecture:** 로직은 모두 `src/coop/`에 두고 코어는 얇은 훅만 단다.
- 보상 화면(`coop-reward.ts`): `SelectModifierPhase`의 협동 분기. 화면에서 상태를 바꾸는 동작(무료 보상 고르기, 리롤, 등급 고정, 아이템 옮기기, 건너뛰기, 상점 구매)을 바로 적용하지 않고 **보상 이벤트**로 바꿔 호스트의 순번 큐에 넣는다. 호스트가 받은 순서대로 순번(`seq`)을 붙여 양쪽에 보내고, 두 클라이언트는 순번 순서대로만 적용한다. 돈 확인과 거절은 적용 시점에 양쪽이 같은 상태로 똑같이 판정한다(결정론). 순번이 아닌 사람의 무료 보상·리롤 입력은 핑이 된다.
- 순번 선택 공통(`coop-choice.ts`): "한 사람이 고르고 상대는 기다렸다가 같은 결과를 적용"하는 선택지 창(`OPTION_SELECT`)과 파티 선택 창의 협동 래퍼. 결정 순번(`nextDecisionSeq`) 키로 결과를 주고받는다. 바이옴, ME 보조 선택지, ME 포켓몬 선택, 부활의 축복이 쓴다. 주인 확인(요청 → 예/아니오)도 여기 있다.
- ME(`coop-encounter.ts`): 제외 목록, ME 선택지 순번(선택지 메시지는 도착 순서 큐), 상대 확인이 필요한 선택지(3.10 표).
- 포켓몬 단위 선택(`coop-pokemon-choice.ts`): 기술 배우기(바꿀 기술 칸 또는 안 배움), 진화 취소(취소 여부, 진화 멈춤 여부).
- 핑(`coop-ping.ts`): 핑 송수신과 화면 표시(보상 화면은 선택지 위 표시, ME·바이옴은 배너 문구).

**Tech Stack:** TypeScript, vitest(jsdom), 기존 `GameManager` 테스트 프레임워크, `LoopbackTransport`, `CoopTestPartner`, 기록-재생 도구(`test/utils/coop-replay.ts`)

**Spec:** `docs/superpowers/specs/2026-10-12-coop-mode-design.md` 3.5(보상과 상점), 3.6(진행 결정), 3.10(ME 협동 대응), 4.2(`choice`, `ping`, `shopBuy`, `confirm`), 4.4 행(보상 선택, 바이옴/ME 선택, ME 포켓몬 선택, ME 제외, 루어 제외, 개별 선택), 4.7(핑), 5장 필수 시나리오(보상 순번, 동시 상점 구매, 잔액 부족, 루어 없음, ME 제외, ME 주인 확인/거절)

**앞 계획:** `2026-10-12-coop-04-battle.md` 구현 메모 8·9번(결정 순번), 16번(남은 대기 문구), 17번(5단계로 넘긴 것), `2026-10-12-coop-02-determinism.md` 구현 메모 8번(보상 선택지 해시)

**단계 나누기:** 범위가 커서 둘로 나눈다. 같은 브랜치에서 순서대로 구현한다.
- **5a (Task 1~6)**: 프로토콜, 루어 제외, 보상 순번과 핑, 상점 동시 구매, 해시 체크포인트, 보상 재생 시나리오
- **5b (Task 7~13)**: 바이옴 순번, ME 제외, ME 선택지 순번, ME 포켓몬 주인 확인, 상대 확인 선택지, 기술 배우기·진화·부활의 축복 주인 입력, 남은 대기 문구 정리, 재생 시나리오, 화면 확인

## Global Constraints

- **솔로 동작은 그대로다.** 모든 훅은 `coopSession`이 `null`이면 기존 코드와 같은 값을 내고 같은 함수를 부른다.
- 코어(`src/` 중 `src/coop/` 바깥) 변경은 훅 호출과 import로 제한한다. 협동 코드가 코어의 private 메서드를 불러야 하면 원소 접근(`phase["applyModifier"]`)을 쓰고 코어의 접근 제한자는 바꾸지 않는다.
- **결과는 양쪽이 같은 함수로 적용한다.** 고르는 사람의 UI는 기존 화면을 그대로 쓰되, 상태를 바꾸는 마지막 지점에서 결과를 메시지로 바꾼다. 상대는 그 메시지를 받아 같은 적용 함수를 부른다. 받은 결과는 다시 검증하지 않는다(신뢰 기반). 단, 돈처럼 동시에 바뀔 수 있는 값은 적용 시점에 양쪽이 같은 규칙으로 판정한다.
- 결정 순번은 두 시뮬레이션이 같은 지점에서만 센다(UI를 다시 열 때 세지 않는다).
- 테스트당 `GameManager` 하나 제약과 "타이틀을 지난 뒤 세션을 연다"를 지킨다.
- 새 파일은 kebab-case, biome 통과(경고 포함), 번역 문구는 `coopText`.

## Review Focus

1. **보상 총량이 늘지 않는가**: 웨이브마다 무료 보상은 한 번, 고르는 사람만 고른다. 순번이 아닌 사람의 보상 입력은 상태를 바꾸지 않는다. → Task 3.
2. **돈이 한 번만 빠지는가**: 둘이 동시에 사도 양쪽 돈이 같고, 산 순서가 같고, 잔액이 모자란 구매는 양쪽 모두에서 거절된다. → Task 4, 6.
3. **양쪽 해시가 같은가**: 보상 순번 두 웨이브, 동시 구매, ME 주인 확인/거절, 진화·기술 배우기를 호스트와 게스트로 재생해 해시가 같다. 보상 화면을 연 시점의 선택지 id도 해시에 들어간다. → Task 5, 6, 12.
4. **남의 포켓몬을 마음대로 바꾸지 않는가**: ME에서 상대 포켓몬을 고르면 주인이 확인해야 진행하고, 거절하면 다시 고른다. 기술 배우기와 진화 취소는 주인 클라이언트에서만 입력한다. → Task 10, 11.
5. **제외 목록**: 협동에서 Safari Zone, The Expert Pokémon Breeder, Fun and Games!가 나오지 않고 루어가 보상에 나오지 않는다. 솔로는 그대로다. → Task 2, 8.

---

## 조사 결과

### A. 연결 지점 (코어)

| 지점 | 파일 | 현재 동작 | 협동 훅 |
|---|---|---|---|
| 루어 가중치 | `src/modifier/init-modifier-pools.ts` `lureWeightFunc` | 클래식 199웨이브나 남은 루어가 많으면 0 | 첫 줄: 협동이면 0(`coopExcludesLures()`). 보상 풀 가중치로 정해지므로 풀에서 빠진다. 상점에는 원래 없다 |
| 보상 화면 열기 | `src/phases/select-modifier-phase.ts` `start` | 선택지 생성 후 `resetModifierSelect(callback)` | 선택지를 만든 뒤 `openCoopRewardScreen(this)`: 화면 세대 번호를 올리고, 이 화면 앞으로 들어온 보상 이벤트를 적용하기 시작 |
| 보상 화면 입력 | `resetModifierSelect` | `MODIFIER_SELECT`에 콜백 전달 | 콜백을 `wrapCoopModifierSelect(this, callback)`로 감싼다. 순번이 아닌 사람: 무료 보상 줄·리롤·등급 고정·아이템 옮기기·취소는 핑 또는 무시. 순번인 사람: 리롤·등급 고정은 이벤트로 보냄. 어느 쪽이든 고른 줄과 칸을 기억해 두고(상점 칸은 평탄화한 번호) 기존 처리로 넘김 |
| 대상 없는 보상/상품 적용 | `applyChosenModifier` 의 `else` | `applyModifier(type.newModifier())` | 협동이면 이벤트로 보냄(`submitCoopRewardChoice(this)`) |
| 대상 포켓몬 선택 후 적용 | `openModifierMenu` 파티 콜백, `openFusionMenu` 파티 콜백 | `MODIFIER_SELECT`로 돌아가 `applyModifier` | 협동이면 대상(`slot`, `option` 또는 `splice`)을 담아 이벤트로 보냄 |
| 아이템 옮기기 | `openModifierTransferScreen` 콜백 | `tryTransferHeldItemModifier` | 협동이면 `{from, itemIndex, quantity, to}` 이벤트 |
| 건너뛰기 | 건너뛰기 확인의 `yesHandler`, 보상이 없을 때의 `selectRewardModifierOption` | `super.end()` | 협동이면 `skip` 이벤트 |
| 바이옴 갈림길 | `src/phases/select-biome-phase.ts` 지도 아이템이 있을 때 | `OPTION_SELECT` | 설정을 `routeCoopOptionSelect(config, picker)`로 감싼다 |
| ME 후보 | `src/battle-scene.ts` `getMysteryEncounter` 바이옴 후보 필터 | 이벤트로 꺼진 ME 제외 | 협동 제외 목록도 뺀다(`isCoopExcludedEncounter`) |
| ME 선택지 | `src/phases/mystery-encounter-phases.ts` `handleOptionSelect` 첫 줄 | 선택 → `onPreOptionPhase` → 진행 | `routeCoopEncounterOption(this, option, index)`: 고르는 사람이면 메시지(상대 확인이 필요한 선택지면 먼저 확인) 후 진행, 아니면 핑 |
| ME 선택지 화면 | `src/ui/handlers/mystery-encounter-ui-handler.ts` `show` 끝 | — | `coopEncounterOptionsShown(this)`: 순번이 아닌 쪽은 배너를 띄우고 다음 선택지 메시지를 기다려 같은 `handleOptionSelect`를 부름 |
| ME 포켓몬 선택 | `encounter-phase-utils.ts` `selectPokemonForOption`, `selectOptionThenPokemon`의 `setMode(PARTY, SELECT)`와 `OPTION_SELECT` | 파티 화면, 보조 선택지 | 파티 화면은 `openCoopPartySelect(callback, filter)`, 보조 선택지는 `routeCoopOptionSelect`. 고르는 사람이 상대 포켓몬을 고르면 주인 확인 |
| 기술 배우기 | `src/phases/learn-move-phase.ts` | 4개면 바꿀지 묻고 요약 화면에서 칸 선택 | 주인 아니면 대기 후 결정 적용, 주인이면 결과(칸 또는 -1)를 보냄. 훅은 `start`(분기), `learnMove`(배운 칸 기록), `end`(결과 전송) |
| 진화 취소 | `src/phases/evolution-phase.ts` `prepareForCycle`, 진화 멈춤 확인 | 진화 중 B로 취소, 취소하면 "진화 멈춤?" | 주인이 아니면 취소 입력을 막고(`canCancel`), 순환 애니메이션 뒤 주인의 결정(`cancelled`, `paused`)을 기다려 같은 분기로 감 |
| 부활의 축복 | `src/phases/revival-blessing-phase.ts` | 파티 화면 | 기술 사용자 주인이 고르고 상대는 기다림(`routeCoopOwnerPartyPick`) |

### B. 보상 이벤트 순번 (스펙 3.5 "호스트가 순서를 정한다")

- 이벤트 모양: `{ t: "reward", wave, gen, req, by, action, seq? }`. `gen`은 요청자가 본 보상 화면의 세대(두 클라이언트가 같은 순서로 여는 보상 화면마다 1씩, 리롤·TM 복사 화면 포함), `req`는 요청자 쪽 번호, `by`는 요청자, `seq`는 호스트가 붙인 순번.
- `action`: `{ kind: "reward", option, slot?, partyOption?, splice? }`(무료 보상), `{ kind: "shop", option, slot?, partyOption? }`(상점, `option`은 `getPlayerShopModifierTypeOptionsForWave` 평탄화 번호), `{ kind: "reroll" }`, `{ kind: "lock" }`, `{ kind: "transfer", from, itemIndex, quantity, to }`, `{ kind: "skip" }`.
- 호스트: 자기 동작은 바로 순번을 붙여 보내고 큐에 넣는다. 게스트 요청은 받은 순서대로 순번을 붙여 양쪽에 보낸다. 호스트는 내용을 검사하지 않는다.
- 적용(양쪽 같음): 열린 보상 화면이 큐를 순번 순서로 하나씩 적용한다. `gen`이 지금 화면보다 작으면 버리고(이미 닫힌 화면에 대한 요청), 크면 그 화면이 열릴 때까지 기다린다. 상점 구매는 그 시점 돈이 모자라면 거절(요청자 화면에 "돈이 부족합니다"), 리롤도 돈이 모자라면 거절. 무료 보상·건너뛰기·리롤은 화면을 닫으므로 그 뒤의 같은 `gen` 이벤트는 버려진다(스펙 "순번인 사람이 고르면 상점도 닫힌다").
- 거절과 버림은 양쪽이 같은 상태로 똑같이 판정하므로 따로 메시지가 없다.
- 기억해 둘 점: 기념품 버섯(상점, `RememberMoveModifierType`)은 솔로에서도 화면을 닫고 복사 화면을 다시 연다. 협동에서도 그대로 두고(누가 사도 화면이 한 번 닫혔다 열림), 기술 고르기는 대상 포켓몬 주인이 한다(Task 11).

### C. 순번 선택 공통

- 순번: `CoopSession.pickerForWave(waveIndex)`(홀수 호스트, 짝수 게스트). 보상, 바이옴, ME가 모두 같은 함수를 쓴다.
- 선택지 창: 결정 순번 하나를 받아, 고르는 사람은 고른 칸 번호를 `choice { kind: "option", seq, index }`로 보내고, 상대는 같은 창을 보되 칸을 고르면 핑이 되고, 결정이 오면 그 칸의 원래 핸들러를 부른다.
- 파티 선택(ME): 결정 순번 하나. 고르는 사람이 상대 포켓몬을 고르면 `choice { kind: "ownerAsk", seq, slot }`을 보내고 `confirm { kind: "mePokemon", seq, accepted }`를 기다린다. 동의하면 `choice { kind: "partySelect", seq, slot }`, 거절하면 "파트너가 거절했습니다" 후 파티 화면을 다시 연다(같은 순번). 취소는 `slot`이 파티 밖.
- ME 선택지: 고르는 사람만 고른다. 고르는 쪽이 같은 화면에서 취소 후 다시 고를 수 있어 열린 횟수가 양쪽에서 다를 수 있으므로, 결정 순번 대신 도착 순서 큐(`meOption`)를 쓴다.

### D. 4단계 인계 사항 처리

| 인계 | 처리 |
|---|---|
| 전투 중 기술 배우기·진화는 주인 입력 | Task 11 |
| ME 안의 포켓몬·선택지 | Task 9, 10 |
| 부활의 축복 같은 파티 선택 | Task 11(부활의 축복). 아이템 대상 선택은 보상 화면 대상(6마리 전체, Task 3)으로 해결 |
| 교체·포획 결정 뒤 "파트너가 고르는 중..." 문구 | Task 12 |
| 보상 선택지 id 해시(2단계 메모 8번) | Task 5 |

---

## 파일 구조

```
src/coop/
  coop-protocol.ts        (수정) 프로토콜 3, reward 이벤트, 결정 종류 추가, confirm.seq, ping 페이로드
  coop-input-broker.ts    (수정) reward 이벤트 수신함, 확인 요청·응답, meOption 큐, 핑 알림
  coop-session.ts         (수정) 보상 순번 큐 상태
  coop-reward.ts          보상 화면 협동 분기, 호스트 순번, 적용 함수
  coop-choice.ts          routeCoopOptionSelect, openCoopPartySelect, 주인 확인, routeCoopOwnerPartyPick
  coop-encounter.ts       제외 목록, ME 선택지 순번, 상대 확인 선택지
  coop-pokemon-choice.ts  기술 배우기, 진화 취소
  coop-ping.ts            핑 송수신과 표시
  coop-text.ts            (수정) 문구
  coop-state-hash.ts      (수정) rewardOptions
test/tests/coop/
  coop-reward.test.ts, coop-shop.test.ts, coop-lure.test.ts, coop-biome.test.ts, coop-encounter.test.ts,
  coop-pokemon-choice.test.ts, coop-ping.test.ts, coop-progress-replay.test.ts
test/utils/
  coop-partner.ts, coop-replay.ts (수정) 보상 이벤트·결정 합성과 재생
```

---

## 5a

### Task 1: 프로토콜 3과 중개자 확장

**Files:** Modify `coop-protocol.ts`, `coop-input-broker.ts`; Test `coop-protocol.test.ts`, `coop-input-broker.test.ts`

**Interfaces:**
- `COOP_PROTOCOL_VERSION = 3`
- `CoopRewardAction`, `| { t: "reward"; wave; gen; req; by: CoopRole; action: CoopRewardAction; seq?: number }` — 스펙 4.2의 `shopBuy`를 일반화(리롤·무료 보상과 상점 구매가 한 순번을 써야 하므로). `shopBuy`는 뺀다.
- `CoopDecision`에 `option`, `partySelect`, `learnMove`, `evolution` 추가
- `confirm`: `{ t: "confirm"; kind; wave; turn?; seq?; accepted }`
- `ping`: `{ t: "ping"; kind: "reward" | "option" | "encounter"; payload: { row?; cursor? ; index? } }`
- 중개자: `onReward(handler)`, `waitConfirm(kind, seq)`, `onChoice(kind, handler)`(`ownerAsk`, `meOption`, `optionAsk`), `takeEncounterOption()`/`waitEncounterOption()`, `onPing(handler)`

- [x] **Step 1: 실패 테스트** — 새 모양 왕복, `reward` 이벤트를 수신 순서대로 넘김, 확인 응답을 순번별로 넘김, `meOption`을 도착 순서로 넘김, 핑 알림
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): extend the protocol for rewards and progression`

### Task 2: 루어 제외

**Files:** Modify `init-modifier-pools.ts`(한 줄); Create `coop-reward.ts`(`coopExcludesLures`); Test `coop-lure.test.ts`

- [x] **Step 1: 실패 테스트** — 협동 보상 풀(`regenerateModifierPoolThresholds` 후 `getModifierPoolForType` 가중치)에 루어 3종 가중치가 0, 여러 시드로 뽑은 보상에 루어가 없다. 솔로는 가중치가 그대로다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): drop lures from co-op rewards`

### Task 3: 보상 순번과 핑

**Files:** Modify `select-modifier-phase.ts`(훅 여러 곳, 위 표); Create `coop-reward.ts`, `coop-ping.ts`; Modify `coop-text.ts`; Test `coop-reward.test.ts`, `coop-ping.test.ts`

**Interfaces:**
- `openCoopRewardScreen(phase)`, `wrapCoopModifierSelect(phase, callback)`, `submitCoopRewardChoice(phase, target?)`, `submitCoopRewardAction(phase, action)`, `getCoopRewardOptionIds()`
- 배너: 순번이 아닌 쪽 "파트너가 보상을 고르는 중... (보상을 고르면 핑)"

- [x] **Step 1: 실패 테스트** (GameManager + 가상 파트너, 웨이브 1 = 호스트 순번)
  - `the picker takes a free reward`: 호스트 클라이언트에서 보상을 고르면 `reward` 이벤트(순번 0)가 나가고 아이템이 한 번 들어간 뒤 다음 웨이브로 간다
  - `the other player waits for the picker`: 게스트 클라이언트(웨이브 1)는 보상을 골라도 아이템이 들어가지 않고 핑이 나간다. 호스트의 보상 이벤트가 오면 같은 아이템이 들어가고 화면이 닫힌다
  - `rerolls only by the picker`: 순번인 사람의 리롤은 돈이 한 번 빠지고 새 선택지로 바뀐다. 상대 클라이언트는 리롤 이벤트를 받아 같은 선택지가 된다
  - `the guest picks on even waves`: 웨이브 2에서는 게스트가 고르는 사람이다. 게스트의 요청은 순번 없이 나가고 호스트가 붙인 순번을 받은 뒤 적용된다
  - `reward targets any of the six`: 순번인 사람이 상대 포켓몬에게 아이템을 준다
  - `pings mark the option on the picker's screen`: 핑을 받으면 해당 선택지에 표시가 생긴다
  - `solo is unchanged`
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): let the wave's picker choose the reward`

### Task 4: 상점 동시 구매

**Files:** Modify `coop-reward.ts`; Test `coop-shop.test.ts`

- [x] **Step 1: 실패 테스트**
  - `both players buy`: 순번이 아닌 사람도 상점에서 산다. 돈이 한 번 빠지고 양쪽에 같은 아이템이 같은 순서로 쌓인다
  - `the host orders simultaneous buys`: 호스트와 게스트가 동시에 사면 호스트가 받은 순서대로 순번이 붙고 그 순서로 적용된다
  - `rejects a buy the wallet cannot cover`: 앞 구매로 돈이 모자라진 구매는 양쪽 모두 적용하지 않고, 요청한 쪽에 "돈이 부족합니다"
  - `buys requested before the reward closes the screen are dropped`: 무료 보상 이벤트 뒤에 순번이 붙은 같은 화면의 구매는 버려진다
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): order simultaneous shop buys through the host`

### Task 5: 해시에 보상 선택지

**Files:** Modify `coop-state-hash.ts`; Test `coop-state-hash.test.ts`

- [x] **Step 1: 실패 테스트** — 보상 화면이 열려 있으면 `rewardOptions`에 무료 선택지 타입 id가 순서대로 들어가고 해시가 달라진다. 화면이 없으면 빈 배열
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): hash the offered rewards`

### Task 6: 보상 재생 시나리오

**Files:** Modify `test/utils/coop-replay.ts`, `test/utils/coop-partner.ts`; Test `coop-progress-replay.test.ts`

- 재생 도구: 시나리오 `reward(wave) => CoopRewardScript[]`(무료 보상 칸, 상점 칸, 리롤, 건너뛰기). 보상 화면이 열릴 때 체크포인트를 남긴다. 기록 실행에서 게스트 요청은 합성하고 호스트 순번 이벤트는 실제 호스트가 만든다. 재생 실행(게스트)은 기록된 호스트 이벤트를 보내되, 게스트 요청에 대한 확정 이벤트는 게스트가 실제로 그 요청을 보낸 뒤에 보낸다.
- [x] **Step 1: 실패 테스트** — `reward turn order over two waves`(웨이브 1 호스트 보상, 웨이브 2 게스트 리롤 후 보상, 3웨이브), `both buy in the shop at once`(같은 화면에서 둘 다 구매, 돈 한 번, 순서 같음), `a buy the wallet cannot cover`. 호스트 실행과 게스트 실행의 해시 열이 같다
- [x] **Step 2~4**, **Step 5: 커밋** — `test(coop): replay reward turns and shop buys`

---

## 5b

### Task 7: 바이옴 순번

**Files:** Modify `select-biome-phase.ts`(한 줄); Create `coop-choice.ts`; Test `coop-biome.test.ts`

- [x] **Step 1: 실패 테스트** — 지도 아이템이 있을 때 순번인 사람의 바이옴 선택이 `choice option`으로 나가고, 상대 클라이언트는 같은 바이옴으로 간다. 상대가 고르면 핑. 솔로 그대로
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): pick the next biome by turn`

### Task 8: ME 제외

**Files:** Modify `battle-scene.ts`(한 줄); Create `coop-encounter.ts`; Test `coop-encounter.test.ts`

- [x] **Step 1: 실패 테스트** — 바이옴 후보가 제외 3개뿐이면 협동에서는 대체 ME(Mysterious Challengers)가 나오고, 솔로에서는 셋 중 하나가 나온다
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): leave out solo-only mystery encounters`

### Task 9: ME 선택지 순번

**Files:** Modify `mystery-encounter-phases.ts`, `mystery-encounter-ui-handler.ts`(훅 한 줄씩); Modify `coop-encounter.ts`; Test `coop-encounter.test.ts`

- [x] **Step 1: 실패 테스트** — 순번인 사람의 선택이 `meOption`으로 나가고, 상대는 배너를 보다 같은 선택지로 진행한다. 상대가 고르면 핑. 보조 선택지(`selectOptionThenPokemon`·`selectPokemonForOption`의 선택지 창)도 순번인 사람의 결과를 따른다
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): choose mystery encounter options by turn`

### Task 10: ME 포켓몬 주인 확인

**Files:** Modify `encounter-phase-utils.ts`(두 곳); Modify `coop-choice.ts`; Test `coop-encounter.test.ts`

- [x] **Step 1: 실패 테스트**
  - `picking the partner's pokemon asks its owner`: 고르는 쪽이 상대 포켓몬을 고르면 상대 화면에 확인 창이 뜨고, 동의하면 양쪽이 그 포켓몬으로 진행
  - `a declined pick goes back to the party`: 거절하면 고르는 쪽 파티 화면이 다시 열리고, 자기 포켓몬을 고르면 확인 없이 진행
  - `own pokemon needs no confirmation`
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): ask the owner before using their pokemon in an encounter`

### Task 11: 상대 확인 선택지, 기술 배우기·진화·부활의 축복

**Files:** Modify `learn-move-phase.ts`, `evolution-phase.ts`, `revival-blessing-phase.ts`(훅); Create `coop-pokemon-choice.ts`; Modify `coop-encounter.ts`; Test `coop-pokemon-choice.test.ts`, `coop-encounter.test.ts`

- [x] **Step 1: 실패 테스트**
  - `the owner chooses the move to forget`: 기술 4개인 게스트 포켓몬이 레벨업으로 기술을 배울 때 호스트 클라이언트는 대기 후 게스트 결정(칸 2)을 적용한다. 게스트 클라이언트는 요약 화면에서 고른 칸을 보낸다. 안 배우기(-1)도 같다
  - `the owner cancels an evolution`: 게스트 클라이언트의 취소가 호스트 클라이언트에 같은 결과(진화 안 함, 멈춤 여부)로 적용된다. 주인이 아닌 쪽은 취소 입력이 먹지 않는다
  - `revival blessing is picked by the user's owner`
  - `dark deal asks the partner first`: 선택지 1은 상대 동의 후 진행, 거절하면 선택지 화면으로 돌아간다
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): let owners decide for their own pokemon`

### Task 12: 남은 대기 문구와 재생 시나리오

- [x] **Step 1: 실패 테스트** — 교체·포획 결정을 적용한 뒤 메시지 창이 비어 있다. 재생: ME 주인 확인 동의/거절, 진화·기술 배우기 주인 결정. 해시 일치
- [x] **Step 2~4**, **Step 5: 커밋** — `fix(coop): clear the waiting text after a partner's choice`, `test(coop): replay progression choices`

### Task 13: 마무리

- [x] **Step 1: 변이 확인** — 루어 훅, 보상 래퍼, 상점 순번 적용, ME 제외 훅, 주인 확인 훅을 하나씩 끄고 해당 테스트 실패 확인
- [x] **Step 2:** `pnpm test test/tests/coop && pnpm typecheck && pnpm biome:ci && pnpm exec ls-lint && pnpm coop:server:test`
- [x] **Step 3: 화면 확인** (실제 게임 두 창): 순번 쪽 보상 화면과 상대의 대기·핑, 둘이 상점에서 사기, 바이옴 갈림길 순번. 스크린샷 `coop-screens-stage5/`
- [x] **Step 4:** 전체 `pnpm test:silent`(백그라운드)
- [x] **Step 5:** "구현 메모" 추가, 체크박스 갱신, 커밋 — `docs: mark co-op rewards plan progress`

---

## 구현 메모 (계획과 달라진 점)

구현하면서 계획과 다르게 정하거나 새로 알게 된 부분이다. 6단계 이후 계획은 이 내용을 기준으로 작성한다.

1. **보상 이벤트 하나로 통일**: 스펙 4.2의 `shopBuy`를 `reward { wave, gen, req, by, action, seq? }`로 바꿨다(프로토콜 3). 리롤·무료 보상·건너뛰기와 상점 구매가 같은 지갑을 쓰므로 한 순번에 들어가야 순서가 갈리지 않는다. 호스트는 내용을 검사하지 않고 받은 순서대로 순번만 붙인다. 돈 부족·닫힌 화면 판정은 적용 시점에 양쪽이 같은 상태로 똑같이 하므로 거절 메시지가 따로 없다(돈 부족이면 요청한 쪽에 "돈이 부족합니다"). 호스트 자신의 동작은 순번을 붙이자마자 바로 적용된다.
2. **화면 세대(`gen`)**: 보상 화면은 리롤·TM 복사본까지 열릴 때마다 양쪽에서 같은 번호를 받는다. 이벤트의 `gen`이 지금 화면보다 작으면 버리고(닫힌 화면에 대한 요청), 크면 그 화면이 열릴 때까지 기다린다. 그래서 리롤 애니메이션 중에 들어온 상점 구매는 버려진다(드문 경합, 설계자 판단).
3. **순번이 아닌 사람의 입력**: 무료 보상 줄과 리롤은 핑, 등급 고정·아이템 옮기기는 오류음, 취소는 무시, 파티 확인과 상점은 그대로 쓴다. 아이템 옮기기는 순번인 사람만 한다(설계자 판단, 스펙에 없음). 화면 위쪽 배너에 "파트너가 보상을 고르는 중 / 고르면 핑을 보냅니다", 핑을 받으면 해당 선택지 위에 "!"와 "파트너: 이거 골라줘!"가 뜬다.
4. **코어 훅 위치(`select-modifier-phase.ts`)**: 화면 열기(`openCoopRewardScreen`), 입력 콜백 감싸기(`resetModifierSelect`), 대상 없는 적용, 파티 콜백 2곳(일반·합체), 아이템 옮기기, 건너뛰기 2곳. 적용 함수는 협동 코드가 다시 만든다(`createModifier`가 솔로 파티 콜백과 같은 인자로 `newModifier`). 상점 구매 적용은 솔로 `applyModifier`의 구매 분기를 그대로 따르되 현재 UI가 보상 화면이라고 가정하지 않는다(상대가 파티 화면에 있을 수 있음). 기념품 버섯은 솔로처럼 화면을 닫고 복사 화면을 연다.
5. **TDD 순서 위반 1건**: 상점 구매 적용과 순번은 Task 3의 순번 큐를 만들면서 함께 작성했고, `coop-shop.test.ts`(Task 4)는 처음부터 통과했다. 보완으로 변이 확인을 했다: 적용 시점 돈 검사를 끄면 잔액 부족 테스트가, 게스트 요청을 호스트 순번 없이 바로 적용하게 바꾸면 2개가 실패한다. "보상 뒤에 순번이 붙은 구매는 버려짐"은 `gen` 검사를 꺼도 통과한다(화면이 닫혀 적용되지 않으므로). `gen` 검사는 리롤 뒤의 옛 화면 요청을 막는 용도다.
6. **해시**: `CoopStateSnapshot.rewardOptions`(열린 협동 보상 화면의 무료 선택지 타입 id). 기록-재생 도구가 보상 화면이 열릴 때 체크포인트를 남긴다.
7. **기록-재생 도구**: 보상 메시지는 턴이 아니라 웨이브에 묶어 `turn: 0`으로 기록한다. 시나리오 옵션 `rewards(wave) => { host?, guest? }`(기본은 순번인 사람이 건너뛰기). 로컬 동작은 UI 대신 `submitCoopRewardAction`으로 넣는다(UI→동작 변환은 단위 테스트가 확인). 첫 화면의 로컬 동작을 먼저 넣은 뒤 만든 상대 요청을 보내 순서를 고정한다. 재생 쪽에서 로컬 요청의 확정 이벤트는 로컬이 그 요청을 보낸 뒤에 보낸다. 합성기 `synthesizeMoveCommand`에 광역기(`targets`)를 추가했다.
8. **바이옴·ME 보조 선택지(`routeCoopOptionSelect`)**: 결정 순번 하나. 고르는 사람의 선택을 `choice option`으로 보내고, 상대는 같은 목록에서 고르면 핑(오류음 포함)이 되고 결정이 오면 원래 핸들러를 부른다. 바이옴 순번은 보상과 같은 `pickerForWave(현재 웨이브)`.
9. **ME 선택지**: 고르는 쪽이 같은 화면에서 취소 후 다시 고를 수 있어 결정 순번 대신 도착 순서 큐(`meOption`)를 쓴다. 기다리는 쪽은 ME 화면이 보일 때(`MysteryEncounterUiHandler.show` 훅) 대기를 하나만 건다. 선택지 화면 자체는 양쪽 모두 보인다.
10. **ME 포켓몬 선택(`setCoopPartySelectMode`)**: 코어 diff를 줄이려고 `globalScene.ui.setMode(UiMode.PARTY, PartyUiMode.SELECT, -1, cb, filter)`와 같은 인자를 받는 함수로 바꿔 끼웠다(호출부 한 줄씩). 상대 포켓몬을 고르면 `choice ownerAsk { seq, slot }` → `confirm mePokemon { seq, accepted }`. 거절하면 "파트너가 허락하지 않았습니다."(누르면 계속) 후 파티 화면을 다시 연다(같은 순번). 묻기 전에 파티 화면을 완전히 닫는다(빨리 거절되면 다시 열기가 같은 모드로 무시되는 경합이 있었음).
11. **상대 확인 선택지(3.10 표)**: Dark Deal 1번, Weird Dream 1번은 항상, An Offer You Can't Refuse 1번은 팔려 가는 포켓몬이 상대 것일 때 `choice optionAsk` → `confirm meOption`. 묻는 동안·거절 결과는 배너로 보인다(ME 화면의 메시지 창은 쓰지 않음). 묻는 번호는 세션별 카운터(응답이 그 번호를 돌려줌).
12. **포켓몬 주인 입력(`coop-pokemon-choice.ts`)**: 기술 배우기는 4칸일 때만 결정(`learnMove { moveIndex | -1 }`)을 주고받는다. 주인 쪽은 `learnMove`에서 칸을 기록하고 `end`에서 보낸다(`LearnMovePhase`에 `end` 재정의 추가). 진화는 순환 애니메이션 끝에서 취소 여부(순번 1), 취소했으면 멈춤 확인에서 멈춤 여부(순번 2). 주인이 아니면 취소 입력이 먹지 않는다. 부활의 축복은 기술 사용자 주인이 고른다(`setCoopOwnerPartyMode`, 6마리 중 기절한 포켓몬). 부활한 포켓몬이 파트너 자리로 들어가는 경우는 다음 웨이브 배치에서 바로잡힌다(남은 위험).
13. **남은 대기 문구**: 교체·포획·기술 배우기 결정을 적용할 때 `showText("", 0)`으로 지운다(4단계 메모 16번 인계).
14. **루어**: `lureWeightFunc` 첫 줄에서 협동이면 0. 보상 풀 가중치로만 정해지므로 풀에서 빠진다. ME 고정 보상 등 가중치를 거치지 않는 경로는 다루지 않았다.
15. **ME 제외**: `getMysteryEncounter`의 바이옴 후보 필터 한 줄. 오버라이드·세이브에서 불러온 ME는 그대로다.
16. **테스트 안정성**: 협동 테스트의 `vi.waitUntil` 기본 1초가 전체 실행 부하에서 모자라 `waitForCoop`(10초)를 두었다. 모듈 전역 상태(묻는 번호 등)는 세션별로 둔다(테스트끼리 섞여 실패했음). `coop-random-call-sites`의 GTS 테스트는 협동 세션을 호스트로 연다(웨이브 45의 ME 순번이 호스트라 게스트로는 선택지가 핑이 됨).
17. **변이 확인**: 루어 훅 → 루어 테스트 1개, 보상 콜백 감싸기 → 보상 테스트 6개, ME 제외 훅 → 제외 테스트 1개, 주인 확인(모두 자기 것 취급) → 2개, 기술 배우기 대기 → 1개, ME 보조 선택지 라우팅 → 2개 실패.
18. **화면 확인 (실제 게임 두 창)**: 스크린샷 `coop-screens-stage5/`. 웨이브 1 보상 화면에서 게스트는 배너를 보고 보상을 고르면 핑이 가며, 호스트 화면의 그 선택지에 "!"와 "파트너: 이거 골라줘!"가 뜬다. 둘이 같은 화면에서 상처약을 사면 양쪽 돈이 ₽2,928로 같고(두 번 차감), 이벤트 순번 0·1이 양쪽 같은 순서로 적용됐다. 호스트가 이상한사탕을 고르자 양쪽 같은 레벨업. 바이옴 갈림길(웨이브 10을 디버그로 만듦)에서 게스트가 고르고 호스트는 "파트너가 고르는 중..."과 핑, 게스트 화면에 "파트너: 산 골라줘!". 확인 중 찾아 고친 점(실패하는 테스트를 먼저 씀):
    - 대상을 고르는 보상을 호스트가 고르면 파티 화면에서 돌아가는 전환이 끝나기 전에 적용(화면 닫기)이 먼저 일어나, 보상 화면 모드가 남아 레벨업 단계에서 멈췄다. 전환이 끝난 뒤 보낸다.
    - 배너가 보상 화면 상점 줄·도구 막대·파티 화면과 겹쳤다. 작은 글씨, 보상 화면에서는 맨 위, 그 밖에는 도구 막대 아래에 두고 다른 화면 뒤로 보낸다(마지막 위치 조정은 다시 찍지 않았다).
    - 남은 것: 순번이 아닌 쪽이 파티 화면을 연 채로 상대 구매가 적용되면 그 화면의 HP 표시는 다시 열 때까지 옛 값이다(상태는 같음). 핑 표시 "!"는 작다.
19. **5단계에서 하지 않은 것 (6·7단계)**: ME에서 얻은 포켓몬의 소유권(고른 사람)과 3마리 한도(`encounter-pokemon-utils.ts` `catchPokemon`의 파티 가득 참 흐름), Clowning Around의 특성 바꾸기 확인 창, Weird Dream·Training Session의 주인 계정 기록(7단계), 대기 중 "세이브 후 나가기"와 연결 끊김(6단계), 체크섬 교환(6단계), 보상 화면 경합 중 버려진 구매의 안내 문구.
20. **회귀 확인 (로컬, 전체 에셋)**: 전체 `pnpm test:silent`가 테스트 파일 488개 통과·1개 실패·8개 건너뜀, 테스트 3353개 통과·1개 실패·6개 건너뜀·111개 todo였다. 실패 1개는 `test/tests/moves/chilly-reception.test.ts`의 20초 시간 초과로, 단독 실행(6개 통과)과 `test/tests/moves` 전체 실행(201개 파일, 1110개 통과·실패 0)에서는 통과했다(협동 코드와 무관한 부하 문제로 판단). `test/tests/coop`는 36개 파일 253개 테스트. `pnpm typecheck`, `pnpm biome:ci`, `pnpm exec ls-lint`, `pnpm coop:server:test`(15개) 통과. 바뀐 파일의 biome 경고는 새로 생긴 것 없음.
