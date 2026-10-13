# 협동 모드 6단계: 세이브와 백엔드 Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. 각 Task는 실패하는 테스트 → 실패 확인 → 구현 → 통과 확인 → 커밋 순서로 진행한다. 로직을 테스트보다 먼저 쓰지 않는다(4단계 메모 5번, 5단계 메모 5번의 순서 위반을 반복하지 않는다).

**Goal:** 협동 런을 호스트 계정의 협동 전용 슬롯(5)에만 저장하고, 호스트가 그 슬롯을 불러와 같은 게스트 계정과 이어할 수 있게 한다. 백엔드(rogueserver 포크)는 `coop` 블록을 보존하고 슬롯 5를 협동 전용으로 받는다. 기다리는 쪽은 "세이브 후 나가기"로 둘 다 타이틀로 돌아갈 수 있고, 연결이 끊기면 60초 동안 재접속을 기다린 뒤(끊긴 동안 못 보낸 메시지는 다시 보냄) 타이틀로 돌아간다. 턴 끝과 웨이브 시작마다 상태 해시를 교환해 어긋나면 기록하고 세이브 후 중단한다.

**Architecture:**
- 백엔드(`/home/user/rogueserver`, 브랜치 `claude/festive-davinci-49n6ht`): `defs.SessionSaveData.Coop *CoopSessionData`, 슬롯 검사 함수 하나(`savedata.ValidateSessionSlot`)를 모든 경로가 쓰고, 슬롯과 데이터 교차 검사(`ValidateSessionSlotData`)는 `UpdateSession` 안에서 한다(`/savedata/session/update`와 `/savedata/updateall` 둘 다 지나가는 곳). gob 직렬화를 순수 함수로 떼어 MariaDB 없이 왕복을 시험한다.
- 프론트엔드 세이브(`coop-save.ts`): 세이브 데이터의 `coop` 블록 생성·정규화, 게스트의 세이브(시스템 데이터만), 백엔드 호환 확인.
- 이어하기(`coop-resume.ts`): 협동 슬롯 읽기, 호스트의 이어하기 연결(코드 → 핸드셰이크 → 계정 확인 → `resume` 전송), 게스트의 `resume` 수신, 양쪽이 같은 JSON 문자열로 세션을 만드는 `resumeCoopRun`.
- 재전송(`reliable-coop-transport.ts`): 연결 직후 양쪽이 전송 계층을 감싼다. 게임 메시지에 순번(`n`)을 붙이고, 받은 쪽은 중복을 버리고 순서를 맞추고, 재접속하면 상대가 확인하지 않은 메시지를 모두 다시 보낸다. 게임 코드는 바뀌지 않는다.
- 연결 감시와 종료(`coop-exit.ts`): 끊김 배너와 60초 타이머, 상대의 `bye`, "세이브 후 나가기", desync를 모두 하나의 종료 함수(`endCoopRun(reason)`)로 모은다. 호스트는 웨이브 시작 세이브를 서버까지 올리고, 게스트는 세션을 저장하지 않으며, 둘 다 타이틀로 간다.
- 대기 버튼(`coop-wait-button.ts`): 중개자에 걸린 대기가 있는 동안 "세이브 후 나가기" 버튼을 보이고 메뉴 키(두 번)나 클릭으로 누른다.
- 체크섬(`coop-checksum.ts`): 턴 끝(`TurnEndPhase`)과 웨이브 시작(`EncounterPhase.doEncounter`)에서 해시를 보내고 받은 해시와 `findFirstDesync`로 비교한다.

**Tech Stack:** Go 1.24(`go test`, `go vet`), TypeScript, vitest(jsdom), `GameManager`, `LoopbackTransport`, `CoopTestPartner`, 기록-재생 도구

**Spec:** `docs/superpowers/specs/2026-10-12-coop-mode-design.md` 3.8(세이브와 끊김), 4.1(desync 감지), 4.2(`checksum`, `resume`, `bye`), 4.6(백엔드), 5장(백엔드 테스트, 이어하기 시나리오)

**앞 계획:** 1단계 메모 5번(끊긴 동안 보낸 메시지는 버림), 2단계 메모 9번(체크섬 훅은 6단계), 3단계 메모 6번(슬롯 5 임시, 게스트도 저장함)·12번(선택 중 끊김), 4단계 메모 10번(이어하기·재도전의 `CheckSwitchPhase`)·17번, 5단계 메모 19번

**단계 나누기:** 범위가 커서 셋으로 나눈다. 같은 브랜치에서 순서대로 구현한다.
- **6a (Task 1~4)**: 백엔드
- **6b (Task 5~11)**: 프론트엔드 세이브와 이어하기
- **6c (Task 12~17)**: 재전송, 끊김, 세이브 후 나가기, 체크섬, 마무리

## Global Constraints

- **솔로 동작과 솔로 세이브는 그대로다.** 모든 훅은 `coopSession`이 `null`이면 기존 코드와 같은 값을 내고 같은 함수를 부른다. 솔로 세이브 JSON에는 `coop` 키가 아예 없다.
- 코어(`src/` 중 `src/coop/` 바깥) 변경은 훅 호출과 import, 타입 한 줄로 제한한다. 코어의 private 메서드는 원소 접근(`gameData["initSessionFromData"]`)으로 부른다.
- 백엔드 변경은 세이브 관련 코드로 제한하고 스키마 마이그레이션은 없다. 솔로 슬롯 0~4의 동작은 그대로다(코옵 블록이 붙은 세이브만 새로 거절).
- 테스트당 `GameManager` 하나 제약, "타이틀을 지난 뒤 세션을 연다"를 지킨다. 대기는 `waitForCoop`.
- 새 파일은 kebab-case, biome 통과(경고 포함), 문구는 `coopText`.

## Review Focus

1. **게스트는 세션을 저장하지 않는가**: 게스트의 `saveAll`은 시스템 데이터만 쓰고 슬롯 5(로컬·서버)에 아무것도 쓰지 않는다. → Task 7.
2. **이어하기 후 양쪽이 같은가**: 같은 세이브에서 호스트와 게스트(다른 계정 데이터)로 이어하면 웨이브 시작 해시와 다음 턴 끝 해시가 같다. → Task 10.
3. **다른 계정은 못 들어오는가**: 세이브에 기록된 게스트 계정(이름과 트레이너 ID)이 아니면 거절하고, 거절당한 쪽과 호스트 모두 타이틀로 간다. → Task 11.
4. **끊김이 진행을 망치지 않는가**: 끊긴 동안 보낸 명령은 재접속 뒤 정확히 한 번 도착하고 순서가 같다. 60초가 지나면 호스트는 웨이브 시작 지점을 저장하고 둘 다 타이틀로 간다. → Task 12, 13.
5. **백엔드 교차 거절**: 솔로 슬롯은 `coop` 세이브를, 슬롯 5는 `coop` 없는 세이브를 거절한다. 슬롯 6과 -1은 여전히 범위 오류. 협동 슬롯 클리어는 시드 완료·데일리 기록을 남기지 않는다. → Task 2~4.

---

## 조사 결과

### A. 백엔드 (rogueserver)

| 경로 | 파일 | 현재 | 변경 |
|---|---|---|---|
| 세션 구조체 | `defs/savedata.go` | 구조체에 없는 필드는 gob 저장 때 사라짐 | `Coop *CoopSessionData \`json:"coop,omitempty"\``, `CoopSessionSlot = 5` |
| gob 저장·읽기 | `db/savedata.go` `StoreSessionSaveData`/`ReadSessionSaveData` | zstd+gob을 함수 안에서 직접 | `encodeSessionSaveData`/`decodeSessionSaveData`로 떼어 냄(동작 같음) |
| 슬롯 범위 | `api/endpoints.go` `handleSession`, `api/savedata/{update,delete,clear,newclear}.go` | `slot < 0 \|\| slot >= 5` 각자 검사 | `ValidateSessionSlot(slot)`: 0~4 또는 5 |
| 슬롯·데이터 교차 | 없음 | — | `UpdateSession`이 `ValidateSessionSlotData` 먼저(두 저장 경로 공통) |
| 클리어 | `api/savedata/clear.go` | 완료면 `TryAddSeedCompletion`, 데일리면 기록 | 협동 슬롯은 세이브 삭제만 |
| 새 클리어 | `api/savedata/newclear.go` | 시드 완료 여부 | 협동 슬롯은 항상 `false`(프론트엔드는 협동에서 부르지 않음, 방어용) |
| 마지막 슬롯 | `db/savedata.go` `GetLatestSessionSaveDataSlot` | 모든 슬롯 중 최신 | 솔로 슬롯만(`slot < SessionSlotCount`). 타이틀 "이어하기"가 협동 슬롯을 솔로로 불러오지 않게 |

- 기존 테스트는 저장소 인터페이스를 흉내 낸 구조체로 순수 함수를 시험한다(`api/account/login_test.go`). DB가 필요한 테스트는 없다. 새 테스트도 같은 방식(가짜 저장소)과 gob 순수 함수로 한다.
- gob은 영값 필드를 보내지 않는다. 빈 배열·맵은 돌아올 때 JSON `null`이 된다(기존 필드도 같음). 프론트엔드가 `coop` 블록을 읽을 때 `null`을 빈 값으로 정규화한다.

### B. 프론트엔드 세이브 경로

| 지점 | 파일 | 현재 | 협동 훅 |
|---|---|---|---|
| 세이브 데이터 만들기 | `src/system/game-data.ts` `getSessionSaveData` | 고정 필드 | 끝에 `...getCoopSaveFields()`(솔로는 빈 객체) |
| 세이브 | `saveAll` 첫 줄 | 시스템+세션을 로컬과 서버(`updateall`)에 | 게스트면 `saveCoopGuestData(this, sync)`: 시스템만(`saveSystem`), 세션 키는 건드리지 않음 |
| 세션 타입 | `src/@types/save-data.ts` `SessionSaveData` | — | `coop?: CoopSessionSaveData` (타입 한 줄) |
| 웨이브 시작 저장 | `encounter-phase.ts` `saveAll(true, X1/X6)` | 모든 웨이브 시작 | 그대로(호스트만 슬롯 5에 쓰게 됨) |
| 타이틀 "이어하기" | `title-phase.ts` `checkLastSaveSlot` | `lastSessionSlot` 그대로 | 협동 슬롯이면 무시(백엔드도 거르지만 방어) |
| 협동 메뉴 표시 | `title-phase.ts` `isCoopAvailable()` | 중계 서버 주소만 확인 | `isCoopAvailable() && (await isCoopBackendCompatible())`: 온라인이면 슬롯 5 조회가 "out of range"면 숨김(결과 캐시) |
| 이어하기 소환 | `title-phase.ts` `end`의 `loaded` 분기 | 소환 0·1 + `CheckSwitchPhase` | `queueCoopResumeSummons()`가 참이면 그것만: 협동 배치(`arrangeCoopParty`) 후 각자 자리 소환, 교체 질문 없음 |
| 재도전 | `game-over-phase.ts` | `enableRetries`면 세이브 다시 불러오기 | 협동이면 재도전 없음(설정이 클라이언트마다 다르고 게스트는 세이브가 없음, 설계자 판단) |
| 새 클리어 | `game-over-phase.ts` `newclear` | 온라인이면 부름 | 협동이면 부르지 않고 지금과 같은 값(클래식은 결과와 무관하게 `true`)으로 진행. 협동 클리어 처리는 7단계 |
| 세이브 후 종료(메뉴) | `menu-ui-handler.ts` `SAVE_AND_QUIT` | 캐시 세션으로 저장 후 리셋 | 협동이면 `coopSaveAndQuit()`(상대에게 알림) |
| 메뉴 키 | `ui-inputs.ts` `buttonMenu` | 모드별 메뉴 | 협동 대기 중이면 대기 버튼이 먼저 받음 |

### C. 이어하기 흐름 (스펙 3.8)

1. 호스트: 협동 메뉴에 협동 슬롯 세이브(`coop` 블록 있음)가 있을 때만 "이어하기"가 보인다. 누르면 참가 코드 → 기다림.
2. 연결되면 핸드셰이크. `hello`에 `trainerId`와 `resume`(호스트가 이어하기일 때 `true`)를 더한다(프로토콜 4).
3. 호스트: 상대 이름과 트레이너 ID가 세이브의 게스트(`participants.guest`, `accounts.guest.trainerId`)와 같으면 `resume { session }`(세이브 JSON 문자열)을 보내고, 다르면 `bye { reason: "wrongAccount" }` 후 "저장된 파트너 계정이 아닙니다."와 함께 타이틀로.
4. 게스트: 상대 `hello.resume`이면 로비로 가지 않고 `resume` 또는 `bye`를 기다린다. `resume`이면 이어하기, `bye wrongAccount`면 "이 협동 세이브의 파트너 계정이 아닙니다."
5. 양쪽 같은 함수 `resumeCoopRun(role, transport, json)`: JSON을 `parseSessionData`로 읽고 → `coop` 블록으로 세션(역할, 소유권, 두 계정 스냅샷, 이벤트, 결정 순번, 보상 화면 번호)을 연 뒤 → `initSessionFromData` → `gameMode.isCoop` → 슬롯 5. 그 뒤 `TitlePhase`가 `loaded`로 끝난다(`EncounterPhase(true)` + 협동 소환).
- 계정 확인을 이름+트레이너 ID로 하는 이유: 오프라인(`bypassLogin`)에서는 모든 계정 이름이 "Guest"라 이름만으로는 구별되지 않는다(설계자 판단).

### D. 재전송 (1단계 메모 5번)

- `ReliableCoopTransport(inner)`: 연결·핸드셰이크 직후 `hostCoop`/`joinCoop`이 감싼다(로비와 세션이 같은 감싼 전송 계층을 씀).
- 보내기: 게임 메시지에 `n`(1부터)을 붙이고, 상대가 확인할 때까지 보낸 함(outbox)에 둔다. 끊긴 동안에도 보낸 함에는 들어간다.
- 받기: `n`이 기대값이면 전달하고 버퍼에 이어지는 것도 전달, 크면 버퍼, 작으면 중복이라 버림. `n` 없는 메시지(상대가 감싸지 않은 경우)는 그대로 전달. 받은 쪽에 넘길 때 `n`은 뗀다.
- 확인(`ack { n }`): 16개 받을 때마다, 그리고 재접속 때. 받으면 보낸 함에서 `n` 이하를 지운다.
- 재접속(`reconnecting` → `connected`): 확인을 보내고 보낸 함 전체를 순서대로 다시 보낸다(받는 쪽이 중복을 버림). 서로 순서가 갈리지 않고 정확히 한 번 전달된다. 재동기화(상태 통째로 맞추기)는 하지 않는다. 같은 입력을 같은 순서로 받으면 락스텝이 그대로 이어지기 때문이다.

### E. 끊김과 종료 (스펙 3.8)

| 상황 | 화면 | 호스트 | 게스트 |
|---|---|---|---|
| 상태 `reconnecting` | 배너 "파트너와 연결이 끊겼습니다. 재접속을 기다리는 중... (60초)" | 60초 타이머 | 60초 타이머 |
| 60초 안에 `connected` | 배너 지움, 재전송(D) | 계속 | 계속 |
| 60초 지남, `closed`, 상대 `bye` | 배너에 이유 → 잠시 뒤 타이틀 | 웨이브 시작 세이브(로컬 캐시)를 서버에 올림 | 저장 안 함 |
| "세이브 후 나가기"(대기 버튼 또는 메뉴) | 상대에게 `bye { reason: "saveAndQuit" }` | 같음 | 저장 안 함 |
| desync | `console.error`로 양쪽 해시 기록, 상대에게 `bye { reason: "desync" }` | 같음 | 저장 안 함 |

- 호스트의 "웨이브 시작 세이브"는 `EncounterPhase`가 웨이브 시작마다 로컬에 쓴 슬롯 5 캐시다. 솔로 메뉴의 세이브 후 종료처럼 `saveAll(true, true, true, true)`로 올린다.
- 로비(스타터 선택) 중에도 같은 감시를 단다. 세이브는 없다.
- 타이틀로 가는 함수(`globalScene.reset(true)`)는 테스트에서 바꿔 끼울 수 있게 둔다(`coopExit.returnToTitle`).

### F. 체크섬 (스펙 4.1, 2단계 메모 9번)

- 체크포인트: `TurnEndPhase.start`의 `this.end()` 직전(기록-재생 도구의 턴 끝과 같은 상태), `EncounterPhase.doEncounter` 첫 줄(웨이브 시작, 이어하기 포함).
- 각 클라이언트가 자기 해시를 기록하고 `checksum { wave, turn, hash }`를 보낸다. 받은 해시 열과 자기 해시 열의 겹치는 앞부분을 `findFirstDesync`로 비교한다. 다르면 E의 desync 처리.
- 해시 계산은 RNG를 쓰지 않으므로 시뮬레이션에 영향이 없다.

---

## 파일 구조

```
rogueserver/
  defs/savedata.go               (수정) CoopSessionData, CoopSessionSlot, Coop 필드
  db/savedata.go                 (수정) gob 함수 분리, 마지막 슬롯은 솔로만
  db/savedata_test.go            gob 왕복
  api/savedata/slots.go          ValidateSessionSlot, IsCoopSessionSlot, ValidateSessionSlotData
  api/savedata/*.go              (수정) 슬롯 검사 통일, 교차 검사, 협동 클리어
  api/savedata/slots_test.go, session_test.go, clear_test.go
  api/endpoints.go               (수정) handleSession 슬롯 검사
src/coop/
  coop-protocol.ts               (수정) 프로토콜 4, hello.trainerId·resume, resume.session 문자열, bye.reason, ack, n
  coop-save.ts                   coop 블록, 게스트 저장, 백엔드 호환 확인
  coop-resume.ts                 이어하기 연결, resumeCoopRun, 이어하기 소환
  reliable-coop-transport.ts     재전송
  coop-exit.ts                   연결 감시, endCoopRun, coopSaveAndQuit
  coop-wait-button.ts            대기 중 "세이브 후 나가기"
  coop-checksum.ts               체크섬 교환
  coop-session.ts                (수정) 참가자 이름, 결정 순번 복원
  coop-input-broker.ts           (수정) 대기 수 알림
  coop-title-menu.ts, coop-connect.ts, coop-lobby.ts, coop-game-start.ts, coop-reward.ts, coop-text.ts (수정)
  loopback-transport.ts          (수정) 테스트용 끊기·재접속
test/tests/coop/
  coop-save.test.ts, coop-resume.test.ts, coop-resume-replay.test.ts, reliable-coop-transport.test.ts,
  coop-exit.test.ts, coop-wait-button.test.ts, coop-checksum.test.ts
```

---

## 6a 백엔드

### Task 1: 협동 필드 왕복

**Files:** `defs/savedata.go`, `db/savedata.go`; Test `db/savedata_test.go`

- [x] **Step 1: 실패 테스트** — 프론트엔드 모양의 JSON(참가자, 소유권 표, 두 계정 스냅샷, 이벤트, 결정 순번, 보상 화면 번호, 프로토콜)을 `SessionSaveData`로 디코드 → gob 인코드 → 디코드 → JSON 인코드하면 `coop` 블록이 같다. 솔로 JSON은 왕복 뒤에도 `coop` 키가 없다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(savedata): keep the co-op block of session saves`

### Task 2: 슬롯 5 허용

**Files:** `api/savedata/slots.go`, `update.go`, `delete.go`, `clear.go`, `newclear.go`, `api/endpoints.go`; Test `slots_test.go`

- [x] **Step 1: 실패 테스트** — `ValidateSessionSlot`: 0~5 허용, -1·6 범위 오류. `Delete`·`Clear`·`NewClear`가 슬롯 5를 받고 6을 거절한다(가짜 저장소).
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(savedata): accept the co-op session slot`

### Task 3: 솔로·협동 교차 거절

**Files:** `api/savedata/slots.go`, `session.go`, `update.go`; Test `session_test.go`

- [x] **Step 1: 실패 테스트** — `UpdateSession`/`Update`: 솔로 슬롯 + `coop` 세이브 거절, 슬롯 5 + `coop` 없는 세이브 거절, 둘 다 저장소를 부르지 않음. 맞는 조합은 저장.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(savedata): keep solo and co-op saves in their own slots`

### Task 4: 협동 클리어, 마지막 슬롯

**Files:** `clear.go`, `newclear.go`, `db/savedata.go`; Test `clear_test.go`

- [x] **Step 1: 실패 테스트** — 슬롯 5 `Clear`는 완료한 클래식 세이브여도 `TryAddSeedCompletion`·데일리 기록 없이 삭제만, 슬롯 5 `NewClear`는 저장소를 읽지 않고 `false`. 솔로는 그대로.
- [x] **Step 2~4** (마지막 슬롯 SQL은 DB가 있어야 시험되므로 테스트 없이 바꾸고 메모에 남긴다), **Step 5: 커밋** — `feat(savedata): never count co-op clears as classic clears`, 푸시

## 6b 프론트엔드 세이브와 이어하기

### Task 5: 프로토콜 4

**Files:** `coop-protocol.ts`, `coop-handshake.ts`, `coop-connect.ts`; Test `coop-protocol.test.ts`, `coop-handshake.test.ts`

- `hello { gameVersion, protocol, accountName, trainerId, resume? }`, `resume { session: string }`, `bye { reason?: "saveAndQuit" | "wrongAccount" | "desync" | "timeout" }`, `ack { n }`, 모든 메시지에 선택 필드 `n`
- 핸드셰이크 결과에 상대 `trainerId`, `resume`
- [x] **Step 1~4**, **Step 5: 커밋** — `feat(coop): protocol 4 for resuming co-op runs`

### Task 6: `coop` 블록

**Files:** `coop-save.ts`, `coop-session.ts`, `game-data.ts`(한 줄), `save-data.ts`(타입 한 줄), `coop-game-start.ts`, `coop-lobby.ts`, `coop-reward.ts`; Test `coop-save.test.ts`

- `CoopSessionSaveData { protocol, participants: { host, guest }, ownership, accounts: { host, guest }, timedEvent, decisionSeq, rewardGen, rewardSeq }`
- [x] **Step 1: 실패 테스트** — 협동 세션의 `getSessionSaveData()`에 블록이 있고 값이 세션과 같다. 솔로에는 `coop` 키가 없다. `null`로 돌아온 배열·맵을 정규화한다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): save co-op metadata with the session`

### Task 7: 호스트만 저장

**Files:** `coop-save.ts`, `game-data.ts`(`saveAll` 첫 줄); Test `coop-save.test.ts`

- [x] **Step 1: 실패 테스트** — (실제 `saveAll`) 호스트는 슬롯 5에 `coop` 블록 세이브를 쓴다. 게스트는 슬롯 5 키를 만들지 않고 시스템 데이터는 쓴다. 솔로는 슬롯 0에 쓰고 `coop`이 없다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): only the host saves the co-op session`

### Task 8: 백엔드 호환 확인과 마지막 슬롯

**Files:** `coop-save.ts`, `title-phase.ts`(두 곳); Test `coop-save.test.ts`, `coop-title-menu.test.ts`

- [x] **Step 1: 실패 테스트** — 슬롯 5 조회가 "slot id 5 out of range"면 호환 아님, "save does not exist"나 세이브면 호환, 오프라인이면 조회 없이 호환. 호환이 아니면 협동 메뉴가 없다. `lastSessionSlot`이 5면 "이어하기"가 없다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): hide co-op when the save server lacks the co-op slot`

### Task 9: 게임 오버(새 클리어, 재도전)

**Files:** `game-over-phase.ts`(두 곳), `coop-save.ts`; Test `coop-save.test.ts`

- [x] **Step 1: 실패 테스트** — 협동 패배 시 재도전 질문이 없다(`enableRetries` 켜도). 협동에서는 `newclear`를 부르지 않는다. 솔로는 그대로.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): no retries or new-clear checks in co-op`

### Task 10: `resumeCoopRun`과 이어하기 소환

**Files:** `coop-resume.ts`, `title-phase.ts`(`loaded` 분기 한 줄), `coop-reward.ts`; Test `coop-resume-replay.test.ts`

- [x] **Step 1: 실패 테스트** — 웨이브 1을 이기고 웨이브 2 시작에 저장된 세이브로, 새 게임에서 호스트로 이어하기 → 웨이브 시작 해시와 한 턴 뒤 해시를 기록, 다시 새 게임에서 다른 계정 데이터의 게스트로 이어하기 → 같은 해시. 소유권과 자리 배치가 저장 전과 같고 교체 질문(`CheckSwitchPhase`)이 없다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): resume a saved co-op run on both clients`

### Task 11: 이어하기 메뉴와 계정 확인

**Files:** `coop-resume.ts`, `coop-title-menu.ts`, `title-phase.ts`(콜백 하나); Test `coop-resume.test.ts`

- [x] **Step 1: 실패 테스트** — 협동 세이브가 있을 때만 "이어하기"가 보인다. 호스트 이어하기: 코드 → 같은 게스트 계정 참가 → `resume`이 가고 `EncounterPhase(loaded)`로 간다. 다른 계정(이름 또는 트레이너 ID): `bye wrongAccount`, 호스트는 안내 후 타이틀. 게스트: 상대가 이어하기면 `resume`을 받아 이어하기, `bye wrongAccount`면 안내.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): continue a saved co-op run with the same partner`

## 6c 재전송, 끊김, 체크섬

### Task 12: 재전송

**Files:** `reliable-coop-transport.ts`, `loopback-transport.ts`(테스트용 끊기), `coop-connect.ts`; Test `reliable-coop-transport.test.ts`, `coop-connect.test.ts`

- [x] **Step 1: 실패 테스트** — 끊긴 동안 보낸 메시지가 재접속 뒤 순서대로 한 번씩 도착, 중복 버림, 순서가 바뀐 도착 정렬, 확인한 메시지는 다시 보내지 않음, `n` 없는 메시지 통과, 연결 결과의 전송 계층이 감싸져 있음.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): resend what a dropped connection lost`

### Task 13: 연결 감시와 종료

**Files:** `coop-exit.ts`, `coop-game-start.ts`, `coop-lobby.ts`, `coop-text.ts`; Test `coop-exit.test.ts`

- [x] **Step 1: 실패 테스트** (GameManager + 끊을 수 있는 파트너)
  - `reconnecting within the window continues`: 끊긴 동안 낸 명령이 재접속 후 파트너에게 가고 턴이 끝난다. 배너가 떴다 사라진다
  - `timing out returns to the title with the host's save`: 슬롯 5에 웨이브 시작 세이브, 타이틀로, 세션 없음
  - `the guest saves nothing when timing out`
  - `the partner's bye ends the run`
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): wait a minute for a dropped partner, then save and quit`

### Task 14: 세이브 후 나가기

**Files:** `coop-wait-button.ts`, `coop-input-broker.ts`, `coop-exit.ts`, `ui-inputs.ts`(한 줄), `menu-ui-handler.ts`(한 줄); Test `coop-wait-button.test.ts`

- [x] **Step 1: 실패 테스트** — 파트너 명령을 기다리는 동안 버튼이 보이고, 메뉴 키 한 번은 확인 문구, 두 번이면 `bye saveAndQuit` → 호스트 저장 → 타이틀. 기다리지 않을 때 메뉴 키는 원래대로. 메뉴의 세이브 후 종료도 상대에게 알린다.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): save and quit while waiting for the partner`

### Task 15: 체크섬 교환

**Files:** `coop-checksum.ts`, `turn-end-phase.ts`, `encounter-phase.ts`(한 줄씩); Test `coop-checksum.test.ts`

- [x] **Step 1: 실패 테스트** — 턴 끝·웨이브 시작에 `checksum`이 나가고, 파트너가 같은 해시를 보내면 계속, 다른 해시를 보내면 오류 기록 후 desync 종료(호스트 저장, 타이틀). 솔로는 체크섬 없음.
- [x] **Step 2~4**, **Step 5: 커밋** — `feat(coop): compare state hashes during the run`

### Task 16: 기존 재생과 회귀

- [x] **Step 1:** `test/tests/coop` 전체, 체크섬 메시지가 섞여도 기존 재생 테스트 통과 확인. 필요하면 테스트 도구만 고친다.
- [x] **Step 2: 변이 확인** — 게스트 저장 훅, `coop` 블록 훅, 이어하기 소환 훅, 재전송, 체크섬 비교, 대기 버튼 훅을 하나씩 끄고 해당 테스트 실패 확인

### Task 17: 마무리

- [x] **Step 1:** `pnpm test test/tests/coop && pnpm typecheck && pnpm biome:ci && pnpm exec ls-lint && pnpm coop:server:test`, 백엔드 `go test ./...`, `go vet ./...`
- [x] **Step 2: 화면 확인** (중계 서버 + 오프라인 개발 서버 + 두 창): 대기 중 "세이브 후 나가기" 버튼, 한쪽 연결을 끊었을 때 재접속 배너, 협동 슬롯 이어하기와 게스트 재참가. 스크린샷 `coop-screens-stage6/`
- [x] **Step 3:** 전체 `pnpm test:silent`(백그라운드)
- [x] **Step 4:** "구현 메모"와 백엔드 배포 메모 추가, 체크박스 갱신, 커밋 — `docs: mark co-op save plan progress`

---

## 구현 메모 (계획과 달라진 점)

구현하면서 계획과 다르게 정하거나 새로 알게 된 부분이다. 7단계 이후 계획은 이 내용을 기준으로 작성한다.

1. **백엔드 커밋 (rogueserver `claude/festive-davinci-49n6ht`, 4개)**: `3eae77a` 협동 블록 보존(gob 인코드·디코드를 `db/savedata.go`의 순수 함수로 분리), `765f4dd` 슬롯 5 허용(`savedata.ValidateSessionSlot` 하나를 get/update/delete/clear/newclear와 `handleSession`이 함께 씀), `437d720` 솔로·협동 교차 거절(`ValidateSessionSlotData`를 `UpdateSession` 안에 둬서 `/savedata/session/update`와 `/savedata/updateall`이 같이 지남), `66f5b2a` 협동 클리어(슬롯 5 `clear`는 삭제만, `newclear`는 저장소를 읽지 않고 `false`, 계정 정보의 마지막 슬롯은 솔로 슬롯만). 새 Go 테스트 12개(가짜 저장소 + gob 순수 함수, DB 없음), `go test ./...`·`go vet ./...`(기본, `beta`, `devsetup` 빌드) 통과.
2. **gob의 빈 값**: gob은 영값을 보내지 않으므로 빈 배열·맵은 서버를 거치면 JSON `null`로 돌아온다(기존 필드도 같음). 백엔드 구조체는 타입을 다 적고(`CoopSessionData`, `CoopParticipants`, `CoopAccounts`, `CoopAccountSnapshot`), 프론트엔드가 읽을 때 `normalizeCoopSaveData`로 빈 값을 채운다. 마지막 슬롯 SQL(`slot < 5`)은 DB가 있어야 시험되므로 테스트가 없다(프론트엔드도 `lastSessionSlot`이 5면 무시하는 방어를 함).
3. **`coop` 블록 모양**: `{ protocol, participants: { host, guest }, ownership, accounts: { host, guest }, timedEvent, decisionSeq, rewardGen, rewardSeq }`. 계획에 없던 `accounts`(두 계정 스냅샷)와 `timedEvent`를 넣었다. 이어하기 때 두 클라이언트가 원래 런과 같은 시뮬레이션 데이터를 쓰게 하려는 것이다(현재 계정 데이터로 다시 뽑으면 이로치·진화 조건이 바뀔 수 있음). 참가자 이름은 로비가 `startCoopRun`에 넘긴다.
4. **게스트 저장**: `saveAll` 첫 줄 훅(`saveCoopGuestData`)이 게스트면 시스템 데이터만 저장한다(`sync`거나 오프라인이면 `saveSystem`, 아니면 솔로처럼 서버 저장 없이 넘어감). 그래서 웨이브 시작·게임 오버·메뉴의 캐시 세이브 경로 모두 게스트 세션을 쓰지 않는다. 협동을 떠날 때(`leaveCoop`) `sessionSlotId`가 5면 0으로 되돌린다. 솔로 런이 슬롯 5에 쓰지 않게 하려는 것이다(테스트가 이 누수를 잡았다).
5. **백엔드 호환 확인**: 온라인이면 타이틀이 처음 한 번 슬롯 5를 조회하고 응답이 `slot id 5 out of range`면 협동 메뉴를 숨긴다(결과 캐시, 네트워크 실패는 캐시하지 않음). 오프라인은 확인하지 않는다.
6. **게임 오버**: 협동은 재도전이 없다(설정이 클라이언트마다 다르고 게스트에게 세이브가 없음, 설계자 판단). `newclear`를 부르지 않고 지금 클래식 경로와 같은 값(`!isDaily`)으로 진행한다. 협동 클리어를 어떻게 셀지는 7단계가 정한다.
7. **이어하기**: 협동 메뉴는 슬롯 5에 협동 세이브가 있을 때만 "이어하기"를 보인다(메뉴가 세이브를 읽은 뒤 열리므로 비동기가 됨). 호스트는 `hello.resume`을 보내고, 들어온 계정의 이름과 트레이너 ID가 세이브의 게스트와 같으면 `resume { session: JSON }`, 다르면 `bye wrongAccount` 후 양쪽에 안내하고 타이틀로 간다. 오프라인에서는 모든 이름이 "Guest"라 트레이너 ID가 실제 구별 수단이다(설계자 판단). 양쪽은 같은 JSON으로 `resumeCoopRun`(세션을 먼저 열고 `initSessionFromData`를 원소 접근으로 부름) 후 `TitlePhase`가 `loaded`로 끝난다. 이어하기 소환은 `queueCoopResumeSummons`(협동 배치 후 각자 자리, 교체 질문 없음 — 뒤에 4단계 메모 19번에서 각자 자기 포켓몬만 묻도록 바뀜). 같은 세이브를 다른 계정 데이터의 호스트·게스트로 이어하면 웨이브 시작과 다음 턴 끝 해시가 같다.
8. **재전송(`ReliableCoopTransport`)**: 핸드셰이크 뒤 `hostCoop`/`joinCoop`이 감싼다. 메시지에 `n`을 붙여 상대가 확인(`ack`, 16개마다와 재접속 때)할 때까지 보관하고, `reconnecting → connected`가 되면 보관함 전체를 다시 보낸다. 받는 쪽은 중복을 버리고 순서를 맞춘 뒤 `n`을 떼고 넘긴다. 재동기화(호스트 상태 통째 전송)는 하지 않았다(같은 입력이 같은 순서로 한 번씩 도착하면 락스텝이 이어짐). 테스트용으로 `LoopbackTransport`에 끊기·복구(`pair.drop()`/`restore()`)를, `CoopTestPartner`에 `reliable` 옵션을 더했다. 기존 테스트 중 연결 결과의 전송 계층이 원래 객체와 같다고 확인하던 두 곳은 감싼 객체인지 확인하도록 바꿨다.
9. **끊김과 종료(`coop-exit.ts`)**: 상태가 `reconnecting`이면 배너에 남은 초를 보이고, 60초가 지나거나 `closed`이거나 상대 `bye`가 오면 `endCoopRun`. 종료는 모두 같은 길이다: 배너에 이유 → 2.5초 뒤 호스트는 웨이브 시작 캐시 세이브를 `saveAll(true, true, true, true)`로 올림(게스트는 저장 없음) → 협동을 떠남 → 남은 페이즈 비우기와 트윈 정지 → 타이틀(`globalScene.reset(true)`). 로비(스타터 선택)도 같은 감시를 단다. 순환 import를 피하려고 슬롯 번호(`COOP_SESSION_SLOT`)를 `coop-session.ts`로 옮기고, 로비는 자기 연결과 떠나는 함수를 종료 모듈에 등록한다.
10. **세이브 후 나가기**: 중개자가 걸린 대기 수를 세고(`waiting`, `onWaitingChange`) 대기 중에만 오른쪽 위에 "[메뉴] 세이브 후 나가기"를 그린다. UI 모드가 아니라 그림이라 상대 입력이 오면 그대로 게임이 이어진다. 메뉴 키를 한 번 누르면 "[메뉴]를 한 번 더 누르면 세이브 후 나갑니다", 두 번이면 `bye saveAndQuit` 후 종료(클릭도 됨). 대기가 없는 화면(보상 화면의 순번이 아닌 쪽 등)은 일반 메뉴의 "저장 후 종료"를 쓰고, 협동에서는 이것도 상대에게 알린다(`ui-inputs.ts`, `menu-ui-handler.ts` 훅 한 줄씩).
11. **체크섬**: `TurnEndPhase.start`의 `end()` 직전, `EncounterPhase.doEncounter` 첫 줄에서 해시를 보내고, 받은 해시와 겹치는 앞부분을 `findFirstDesync`로 비교한다. 다르면 `console.error`로 양쪽 값을 남기고 `bye desync` 후 종료(호스트 저장). 기록-재생으로 호스트·게스트가 보낸 체크섬 열이 같음을 확인했다.
12. **업스트림 병합(#7369 파티 순서 바꾸기)**: 원격 브랜치에 사용자가 병합한 beta 변경(108296f)을 병합했다(병합 커밋, assets 포인터 9378069 유지, 충돌 없음). #7369는 보상 화면의 팀 확인에서 파티 순서를 바꾸고 다음 웨이브에 `PartyReorderSwitchPhase`가 그 순서대로 필드를 바꾼다. 협동에서는 파티 순서가 공유 상태라(해시에 들어감) 한쪽만 바꾸면 갈라지고, 그 페이즈가 지원 모드의 빈자리에 상대 포켓몬을 내보낼 수 있다. 그래서 협동에서는 순서 바꾸기 옵션과 모드를 막고 그 페이즈는 아무것도 하지 않는다(`canReorderParty`, 코어 세 곳 한 줄씩). 협동은 기존대로 웨이브 시작에 각자 자리를 배치한다.
13. **변이 확인**: 게스트 저장 훅 → 1개, `coop` 블록 훅 → 2개, 재전송 → 2개, 계정 확인 → 2개, 이어하기 소환 훅 → 1개, 로비 감시 → 1개, 메뉴 키·메뉴 저장 후 종료 훅 → 3개, 체크섬 훅·비교 → 3개, newclear 훅 → 1개 실패.
14. **화면 확인 (실제 게임 두 창, 오프라인 모드)**: 스크린샷 `coop-screens-stage6/`. 하네스가 페이지의 WebSocket을 기록하고 새 연결을 막을 수 있게 해서 게스트의 중계 소켓만 끊었다.
    - 대기 중 버튼(05), 끊김 배너와 남은 초(06·07·14), 짧게 끊었다 복구하면 배너가 사라지고(15) 끊긴 동안 고른 게스트 명령이 재전송되어 턴이 진행되며 양쪽 턴 끝 해시가 같았다(`fec1f1aefb507732`). 처음 시도는 브라우저가 초당 2프레임 정도라 키 입력이 늦어 60초를 넘겼고, 양쪽이 시간 초과 경로로 타이틀에 갔다(08, 호스트는 슬롯 5 저장).
    - 이어하기: 호스트 메뉴에 "이어하기"(09), 코드(10), 게스트 "저장된 협동 런을 불러오는 중..."(11), 양쪽이 같은 웨이브·같은 적으로 재개(12·13), 웨이브 시작 해시 같음(`104e67dbf834844a`).
    - 세이브 후 나가기: 확인 문구(16) → 두 번째 누름에 `bye saveAndQuit`이 게스트에 가고 둘 다 타이틀, 호스트만 `sessionData5`가 남고 게스트에는 세션 세이브가 없음(17·18).
    - 확인 중 찾아 고친 점(각각 실패하는 테스트를 먼저 씀): 버튼이 왼쪽 위 적 정보 창과 겹쳐 오른쪽 위로 옮김, 끊김 문구가 길어 버튼에 닿아 줄임, 게스트가 기술 애니메이션 도중 타이틀로 가면서 트윈이 사라진 스프라이트를 건드려 오류가 나서 떠나기 전에 페이즈를 비우고 트윈을 멈춤.
    - 확인하지 못한 것: 실제 rogueserver(MariaDB)를 띄운 온라인 저장·조회·교차 거절, 수정 안 된 서버에서 협동 메뉴 숨김(단위 테스트만), 중계 서버의 방 만료와 겹친 재접속(60초 경계).
15. **회귀 확인 (로컬, 전체 에셋, 업스트림 병합 후)**: 전체 `pnpm test:silent`가 테스트 파일 497개 통과·2개 실패·8개 건너뜀, 테스트 3409개 통과·2개 실패·6개 건너뜀·111개 todo였다. 실패 2개(`test/tests/moves/telekinesis.test.ts`의 20초 시간 초과, `test/tests/mystery-encounter/encounters/field-trip-encounter.test.ts`의 선택지 속성 비교)는 둘만 따로 돌리면 23개 모두 통과해 부하 문제로 판단했다(협동 코드와 무관). `test/tests/coop`는 45개 파일 305개 테스트 통과. `pnpm typecheck`, `pnpm biome:ci`, `pnpm exec ls-lint`, `pnpm coop:server:test`(15개) 통과. 백엔드 `go test ./...`(최상위 테스트 14개, 새로 12개)와 `go vet ./...` 통과.
16. **남은 것 (7단계 이후)**: 협동 클리어의 계정 처리(지금은 `newclear` 없이 클래식과 같은 값), 재동기화(호스트 상태 전송), 보상 화면 순번이 아닌 쪽의 버튼(지금은 일반 메뉴), 끊김 배너가 스타터 선택 화면 뒤에 가려지는 점(배너는 다른 화면 뒤에 그림), ME에서 얻은 포켓몬의 소유권과 3마리 한도(5단계 메모 19번), 대기 버튼과 배너의 세밀한 배치.

### 수정된 백엔드 배포·실행 메모

- 브랜치: `SunghoLee98/rogueserver`의 `claude/festive-davinci-49n6ht`. 스키마 변경이 없어 기존 DB에 그대로 올리면 된다. 기존 솔로 세이브는 그대로 읽힌다.
- 로컬 개발: rogueserver 저장소에서 `docker compose -f docker-compose.Development.yml up --build`(MariaDB 포함, `devsetup` 빌드가 테이블을 만듦, 서버는 `localhost:8001`). Go로 직접 돌릴 때는 MariaDB를 띄운 뒤 `go build -tags=devsetup . && debug=true dbaddr=127.0.0.1 dbuser=pokerogue dbpass=pokerogue dbname=pokeroguedb gameurl=http://localhost:8000 ./rogueserver`(설정은 환경 변수로 받는다, `rogueserver.go`의 `getEnv`).
- 프론트엔드: 로그인 모드로 띄워야 서버 저장을 쓴다. `VITE_BYPASS_LOGIN=0 VITE_SERVER_URL=http://localhost:8001 VITE_COOP_RELAY_URL=ws://localhost:8787 pnpm exec vite --mode development --port 8000`, 중계 서버는 `PORT=8787 node coop-server/src/main.ts`.
- 확인 순서: 두 계정으로 로그인 → 협동 메뉴가 보이는지(안 보이면 서버가 슬롯 5를 모름) → 웨이브를 넘긴 뒤 호스트 계정의 슬롯 5(`/savedata/session/get?slot=5`)에 `coop` 블록이 있고 게스트 계정에는 없는지 → 호스트 "이어하기".
- 운영 배포는 기존 rogueserver와 같다(Dockerfile 또는 `go build`). 수정 안 된 서버에서는 프론트엔드가 협동 메뉴를 숨기므로 솔로는 어느 조합에서도 영향이 없다.
