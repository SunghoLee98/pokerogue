# 협동 모드 1단계: 통신 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 게임 코드를 건드리지 않고, 두 클라이언트가 참가 코드로 연결되어 버전 확인 후 협동 메시지를 주고받는 통신 계층과 중계 서버를 만든다.

**Architecture:** 게임 로직은 `CoopTransport` 인터페이스만 안다. 구현체는 테스트용 `LoopbackTransport`와 중계 서버에 붙는 `RelayWebSocketTransport` 두 개다. 중계 서버(`coop-server/`)는 참가 코드를 발급하고 같은 방의 두 연결 사이에서 텍스트 프레임을 그대로 전달만 한다. 그 위에 연결 직후 버전을 맞추는 핸드셰이크와, 이후 단계가 쓸 `CoopSession`/`CoopOwnership` 뼈대를 둔다.

**Tech Stack:** TypeScript, vitest(jsdom, 루트 테스트), Node 24(`.nvmrc` v24.9.0, `.ts` 직접 실행), `ws`(중계 서버 전용), `node:test`(중계 서버 테스트)

**Spec:** `docs/superpowers/specs/2026-10-12-coop-mode-design.md` (4.2 통신 추상화, 4.3 협동 세션 계층)

## 전체 로드맵

스펙 6장의 구현 순서를 독립적으로 테스트 가능한 계획 7개로 나눈다. 이 문서는 1번이다. 2번부터는 앞 계획이 끝난 뒤, 그때의 코드를 보고 작성한다.

| # | 계획 | 스펙 범위 | 산출물 |
|---|---|---|---|
| 1 | 통신 기반 (이 문서) | 4.2, 4.3 뼈대 | 연결, 핸드셰이크, 메시지 송수신. 게임 코드 변경 없음 |
| 2 | 결정론 | 4.1 | `randInt` 정리, 시뮬레이션 데이터 소스, 상태 해시, 재생 기반 desync 테스트 도구 |
| 3 | 연결 UI와 스타터 선택 | 3.1, 3.2, 4.5 | 타이틀 메뉴, 코드 입력, 5코스트·3마리 선택, 레디, 게임 시작 |
| 4 | 전투 | 3.3, 3.4, 3.9, 4.4 전투 행 | 2대2 강제, 단일 고정 전투, 최종보스 1.5배, 명령 분배, 볼, 도망 동의, 포획 소유권, 지원 모드 |
| 5 | 보상과 진행 | 3.5, 3.6, 3.10, 4.7 | 보상 순번, 상점 동시 구매, 바이옴·ME 순번, ME 주인 확인과 제외, 루어 제외, 핑 |
| 6 | 세이브와 백엔드 | 3.8, 4.6 | rogueserver 포크 변경, 호스트 전용 세이브, 이어하기, 재접속, 대기 중 나가기, desync 감지 |
| 7 | 계정 진행도와 기록 | 3.7 | 도감·캔디·알 소유자 기록, 협동 클리어 업적, 협동 기록 탭 |

**스펙과 다른 점 (2번 계획에서 반영):** 스펙 5장은 `LoopbackTransport`로 게임 인스턴스 두 개를 한 테스트 안에서 돌린다고 했다. 하지만 `globalScene`(`src/globals/global-scene.ts`)과 `Phaser.Math.RND`가 전역 싱글턴이라 한 프로세스에 게임 두 개를 동시에 띄울 수 없다. 2번 계획에서는 "호스트 역할로 한 번 돌리며 입력과 해시를 기록 → 같은 프로세스에서 게스트 역할(다른 계정 데이터)로 다시 돌리며 기록된 원격 입력을 재생 → 해시 순서 비교" 방식으로 바꾼다. 이 계획의 `LoopbackTransport`는 통신 계층 테스트용으로만 쓴다.

## Global Constraints

- 코어 코드(`src/` 중 `src/coop/` 바깥)는 이 계획에서 수정하지 않는다. 예외는 경로 별칭(`tsconfig.json`)과 환경 변수 타입(`src/vite.env.d.ts`) 두 줄뿐이다.
- 중계 서버는 게임 로직을 갖지 않는다. 받은 게임 메시지를 해석하지 않고 그대로 전달한다.
- 참가 코드: 6자리 영숫자, 10분 미사용 시 만료, 한 코드당 최대 2명. (스펙 4.2)
- 연결이 끊긴 쪽은 60초 안에 같은 방으로 재접속할 수 있다. (스펙 3.8)
- 메시지는 버전 필드를 가진 JSON이다. 클라이언트 게임 버전이 다르면 연결 단계에서 거절한다. (스펙 4.2)
- 웹 배포 시 중계 서버 주소는 `VITE_COOP_RELAY_URL` 환경 변수로 지정한다. (스펙 4.2)
- 로컬 모드 참가 코드 형식: `192.168.0.10:8787/ABCD12`. 로컬 서버 실행: `pnpm coop:local`. (스펙 4.2)
- 새 파일은 kebab-case 이름(`.ls-lint.yml`), biome 통과, REUSE 라이선스 표기가 있어야 한다. `src/**/*.ts`와 `test/**/*.ts`는 `REUSE.toml` 기본 표기가 적용된다. `coop-server/` 파일은 각 파일 첫 줄에 SPDX 주석을 단다(아래 Task 3).

## Review Focus

1. **참가 코드 입력 실수**: 소문자, 앞뒤 공백, 중간 하이픈을 섞어 입력해도 같은 방으로 들어가야 한다. → Task 2 `normalizeJoinCode` 테스트, Task 4 `parseJoinInput` 테스트.
2. **세 번째 사람의 입장**: 이미 2명인 방에 들어오면 기존 두 사람의 연결은 그대로고, 들어온 쪽만 "방이 가득 참" 오류를 받아야 한다. → Task 3 `rejects a third client` 테스트.
3. **핸드셰이크 중 상대가 나감**: 상대가 hello를 보내기 전에 끊기면 핸드셰이크가 영원히 기다리지 않고 실패해야 한다. → Task 5 `rejects when the peer closes before hello` 테스트.
4. **구독 전에 도착한 메시지**: 연결 직후 상대가 바로 보낸 hello가 핸들러 등록 전에 와도 잃어버리지 않아야 한다. → Task 2·4 `buffers messages until the first handler subscribes` 테스트.
5. **만료되거나 없는 코드**: 오타 난 코드나 만료된 코드로 참가하면 무한 대기가 아니라 즉시 "코드를 찾을 수 없음"이 나와야 한다. → Task 3 `rejects an unknown code` 테스트, Task 4 `join rejects with the relay error` 테스트.

---

## 파일 구조

```
src/coop/
  coop-protocol.ts          메시지 타입, 프로토콜 버전, encode/decode, 참가 코드 정규화
  coop-transport.ts         CoopTransport 인터페이스와 상태 타입
  loopback-transport.ts     테스트용 한 쌍 연결
  relay-websocket-transport.ts  중계 서버 클라이언트, 참가 입력 파싱
  coop-handshake.ts         hello 교환과 버전 검사
  coop-ownership.ts         포켓몬 id → 소유자
  coop-session.ts           세션 단일 진입점과 전역 참조
coop-server/
  package.json              ws 의존성, test/start 스크립트
  src/relay-protocol.ts     서버↔클라이언트 제어 메시지 타입 (클라이언트와 공유하지 않고 복제, 이유는 Task 3)
  src/room-registry.ts      방 생성, 입장, 재입장, 만료
  src/relay-server.ts       ws 서버, 프레임 전달
  src/main.ts               포트 읽고 서버 시작
  test/*.test.ts            node:test
test/tests/coop/
  coop-protocol.test.ts, loopback-transport.test.ts,
  relay-websocket-transport.test.ts, coop-handshake.test.ts, coop-session.test.ts
```

---

### Task 1: 경로 별칭과 프로토콜 타입

**Files:**
- Modify: `tsconfig.json` (`paths`에 `"#coop/*": ["./src/coop/*.ts"]` 추가, `#test/*` 위)
- Modify: `src/vite.env.d.ts` (`ImportMetaEnv`에 `readonly VITE_COOP_RELAY_URL?: string;`)
- Create: `src/coop/coop-protocol.ts`
- Test: `test/tests/coop/coop-protocol.test.ts`

**Interfaces:**
- Produces:
  - `export const COOP_PROTOCOL_VERSION = 1;`
  - `export type CoopRole = "host" | "guest";`
  - 스펙 4.2의 `CoopMessage` 유니온 전체. 아직 정의되지 않은 페이로드는 이후 계획에서 좁힌다:
    `export type CoopStarterPayload = Record<string, unknown>;` `export type TurnCommandPayload = Record<string, unknown>;` `export type CoopWorldData = Record<string, unknown>;` `export type CoopSessionSnapshot = Record<string, unknown>;`(스펙의 `resume.session`), `export type CoopChoiceKind = string;`
    `shopBuy`는 `{ t: "shopBuy"; wave: number; seq?: number; option: number; target: number }`, `confirm`은 `{ t: "confirm"; kind: "mePokemon" | "meOption" | "flee"; wave: number; accepted: boolean }`.
  - `export function encodeCoopMessage(message: CoopMessage): string`
  - `export function decodeCoopMessage(raw: string): CoopMessage | null` — JSON이 아니거나 객체가 아니거나 `t`가 알려진 종류가 아니면 `null`.
  - `export function normalizeJoinCode(input: string): string | null` — 공백과 `-` 제거, 대문자화, 결과가 정확히 `[A-Z0-9]{6}`가 아니면 `null`.

- [x] **Step 1: 실패하는 테스트 작성**

```ts
describe("coop-protocol", () => {
  it("round-trips every message kind", () => {
    const messages: CoopMessage[] = [
      { t: "hello", gameVersion: "1.12.1.0", protocol: COOP_PROTOCOL_VERSION, accountName: "a" },
      { t: "shopBuy", wave: 3, option: 1, target: 4 },
      { t: "confirm", kind: "flee", wave: 7, accepted: false },
      { t: "bye" },
    ];
    for (const m of messages) {
      expect(decodeCoopMessage(encodeCoopMessage(m))).toEqual(m);
    }
  });
  it("returns null for malformed input", () => {
    expect(decodeCoopMessage("not json")).toBeNull();
    expect(decodeCoopMessage("[]")).toBeNull();
    expect(decodeCoopMessage('{"t":"nope"}')).toBeNull();
  });
  it("normalizes join codes", () => {
    expect(normalizeJoinCode(" ab-c1 23 ")).toBe("ABC123");
    expect(normalizeJoinCode("ABC12")).toBeNull();
    expect(normalizeJoinCode("ABC12!")).toBeNull();
  });
});
```

- [x] **Step 2: 실패 확인** — Run: `pnpm test test/tests/coop/coop-protocol.test.ts` / Expected: FAIL, `#coop/coop-protocol` 모듈을 찾을 수 없음
- [x] **Step 3: 별칭, 환경 변수 타입, `coop-protocol.ts` 구현.** `decodeCoopMessage`는 알려진 `t` 값 목록(`as const` 배열)으로 검사한다. 필드 단위 검증은 하지 않는다(신뢰 기반, 스펙 2장 비목표).
- [x] **Step 4: 통과 확인** — Run: `pnpm test test/tests/coop/coop-protocol.test.ts && pnpm typecheck` / Expected: PASS, 타입 오류 없음
- [x] **Step 5: 커밋** — `git add tsconfig.json src/vite.env.d.ts src/coop test/tests/coop && git commit -m "feat(coop): add co-op protocol types"`

---

### Task 2: CoopTransport 인터페이스와 LoopbackTransport

**Files:**
- Create: `src/coop/coop-transport.ts`, `src/coop/loopback-transport.ts`
- Test: `test/tests/coop/loopback-transport.test.ts`

**Interfaces:**
- Consumes: `CoopMessage` (Task 1)
- Produces:
  - `export type Unsubscribe = () => void;`
  - `export type CoopConnectionStatus = "connecting" | "waitingForPeer" | "connected" | "reconnecting" | "closed";`
  - 스펙 4.2의 `CoopTransport` 인터페이스 그대로.
  - 모든 구현체 공통 규칙: 첫 `onMessage` 핸들러가 등록되기 전에 도착한 메시지는 버퍼에 쌓았다가 등록 시 순서대로 전달한다. `close()` 후 `send`는 조용히 무시한다.
  - `export function createLoopbackPair(): { host: CoopTransport; guest: CoopTransport }` — `host()`는 `{ joinCode: "LOOP00" }`, 게스트 `join("LOOP00")` 시 양쪽 상태가 `"connected"`. 다른 코드면 `Error("unknown join code")`로 reject. 메시지는 `queueMicrotask`로 비동기 전달(실제 네트워크처럼 같은 틱에 도착하지 않음). 한쪽 `close()` 시 상대 상태 `"closed"`.

- [x] **Step 1: 실패하는 테스트 작성** — 테스트 이름과 단언:
  - `delivers messages both ways in order`: host가 `bye` 직전 `hello` 두 개를 보내면 guest 핸들러가 같은 순서로 받는다.
  - `buffers messages until the first handler subscribes`: guest가 핸들러 없이 있을 때 host가 보낸 `hello`를 나중에 등록한 핸들러가 받는다.
  - `notifies the peer on close`: host `close()` 후 guest `onStatusChange`가 `"closed"`를 받고, 이후 host `send`는 throw하지 않는다.
  - `join rejects an unknown code`: `await expect(guest.join("ZZZZZZ")).rejects.toThrow("unknown join code")`.
- [x] **Step 2: 실패 확인** — Run: `pnpm test test/tests/coop/loopback-transport.test.ts` / Expected: FAIL, 모듈 없음
- [x] **Step 3: 구현**
- [x] **Step 4: 통과 확인** — 같은 명령 / Expected: PASS
- [x] **Step 5: 커밋** — `git commit -m "feat(coop): add transport interface and loopback transport"`

---

### Task 3: 중계 서버 (`coop-server/`)

**Files:**
- Create: `coop-server/package.json`, `coop-server/src/relay-protocol.ts`, `coop-server/src/room-registry.ts`, `coop-server/src/relay-server.ts`, `coop-server/src/main.ts`, `coop-server/test/room-registry.test.ts`, `coop-server/test/relay-server.test.ts`
- Modify: 루트 `package.json` scripts에 `"coop:local": "node coop-server/src/main.ts"`, `"coop:server:test": "pnpm --dir coop-server test"`
- Modify: `biome.jsonc`는 건드리지 않는다(루트 biome가 `coop-server/`도 검사해야 함). `tsconfig.json` `include`에 넣지 않는다(별도 런타임).

**Interfaces:**
- Produces (서버↔클라이언트 제어 메시지, `relay-protocol.ts`. 게임 메시지와 구분하려고 `t`가 `relay:`로 시작):
  - 서버 → 클라이언트: `{ t: "relay:code"; code: string }`(호스트 생성 직후), `{ t: "relay:paired" }`(두 명이 모였을 때와 재입장 성공 시 양쪽에), `{ t: "relay:peerLeft" }`(상대 소켓이 끊겼을 때), `{ t: "relay:error"; reason: "notFound" | "full" | "badRequest" }` 후 서버가 소켓을 닫음.
  - 접속 URL 쿼리: 새 방 `?role=host`, 참가 `?code=ABC123`, 재입장 `?code=ABC123&rejoin=host|guest`.
  - `relay:`로 시작하지 않는 텍스트 프레임은 해석 없이 상대 소켓에 그대로 전달. 상대가 없으면 버린다.
  - 클라이언트 쪽(`src/coop/relay-websocket-transport.ts`)은 이 타입을 복제해서 쓴다. 서버는 루트 tsconfig 밖의 별도 런타임이라 import로 공유하지 않는다. 두 곳 첫 줄에 "coop-server/src/relay-protocol.ts와 동기화" 주석.
- `RoomRegistry` (`room-registry.ts`, 시간 주입으로 테스트):
  - `constructor(now: () => number = Date.now, random: () => number = Math.random)`
  - `createRoom(): string` — 겹치지 않는 6자리 `[A-Z0-9]` 코드
  - `join(code: string, slot: "guest" | "host" = "guest"): "ok" | "notFound" | "full"`
  - `leave(code: string, slot: "host" | "guest"): void` — 자리를 비우고 `vacatedAt` 기록
  - `sweep(): string[]` — 만료된 방 코드를 지우고 반환. 만료 규칙: 게스트가 한 번도 안 들어온 방은 생성 후 `10 * 60_000`ms, 빈 자리가 있는 방은 그 자리가 빈 지 `60_000`ms, 둘 다 비면 즉시.
- `startRelayServer(options: { port: number; host?: string }): Promise<{ port: number; close(): Promise<void> }>` — `port: 0`이면 임의 포트. 10초마다 `sweep()`.
- `main.ts`: `PORT` 환경 변수(기본 `8787`), `HOST`(기본 `0.0.0.0`, LAN 접속 허용), 시작 시 `coop relay listening on <host>:<port>` 출력.
- `coop-server/package.json`: `"type": "module"`, `"private": true`, `"engines": { "node": ">=24" }`, dependencies `ws`(작성 시점에서 2주 이상 지난 정확한 버전, pnpm `minimumReleaseAge: 1440` 준수), devDependencies `@types/ws`, scripts `"test": "node --test test/"`, `"start": "node src/main.ts"`. Node 24의 타입 제거 실행을 쓰므로 `enum`, 매개변수 프로퍼티 같은 비삭제 문법은 쓰지 않는다.
- 각 파일 첫 줄: `// SPDX-FileCopyrightText: 2026 SunghoLee98` / `// SPDX-License-Identifier: AGPL-3.0-only`(`package.json`은 `REUSE.toml`에 `coop-server/package.json`을 CC0 목록에 추가).

- [x] **Step 1: `room-registry` 실패 테스트 작성** — 테스트 이름과 단언:
  - `creates unique six-character codes`: 100번 생성해 모두 `/^[A-Z0-9]{6}$/`이고 중복 없음.
  - `rejects a third client`: `join(code)` 두 번째는 `"full"`.
  - `rejects an unknown code`: `join("ZZZZZZ")`는 `"notFound"`.
  - `expires an unjoined room after ten minutes`: 시간 `+599_999`에 `sweep()`은 `[]`, `+600_000`에 `[code]`.
  - `keeps a vacated slot for sixty seconds`: 참가 후 `leave(code,"guest")`, `+59_999` 시 `join(code,"guest")`가 `"ok"`; 다른 방에서 `+60_000` 후 `sweep()`에 포함.
- [x] **Step 2: 실패 확인** — Run: `pnpm --dir coop-server install && pnpm coop:server:test` / Expected: FAIL, 모듈 없음
- [x] **Step 3: `room-registry.ts` 구현**
- [x] **Step 4: `relay-server` 실패 테스트 작성** — `startRelayServer({ port: 0 })`에 `ws` 클라이언트 3개로 접속:
  - `pairs host and guest and forwards frames verbatim`: 호스트가 `relay:code`를 받고, 게스트가 그 코드로 접속하면 양쪽이 `relay:paired`, 호스트가 보낸 `'{"t":"hello","x":1}'`을 게스트가 바이트 그대로 받는다.
  - `rejects a third client`: 세 번째 접속이 `{t:"relay:error",reason:"full"}` 후 닫히고, 기존 두 연결은 계속 메시지를 주고받는다.
  - `tells the peer when one side drops and allows rejoin`: 게스트 소켓 종료 → 호스트가 `relay:peerLeft`; `?code=X&rejoin=guest`로 재접속 → 양쪽 `relay:paired`.
  - `rejects a bad request`: 쿼리 없이 접속하면 `reason:"badRequest"`.
- [x] **Step 5: `relay-server.ts`, `main.ts` 구현**
- [x] **Step 6: 통과 확인** — Run: `pnpm coop:server:test` / Expected: PASS 9개
- [x] **Step 7: 수동 확인** — Run: `pnpm coop:local` / Expected: `coop relay listening on 0.0.0.0:8787` 출력, Ctrl+C로 종료
- [x] **Step 8: 린트 확인** — Run: `pnpm biome:ci && pnpm exec ls-lint && uvx reuse lint` / Expected: 모두 통과
- [x] **Step 9: 커밋** — `git commit -m "feat(coop): add relay server"`

---

### Task 4: RelayWebSocketTransport

**Files:**
- Create: `src/coop/relay-websocket-transport.ts`
- Test: `test/tests/coop/relay-websocket-transport.test.ts`

**Interfaces:**
- Consumes: `CoopTransport`, `CoopConnectionStatus`, `Unsubscribe` (Task 2), `encodeCoopMessage`/`decodeCoopMessage`/`normalizeJoinCode` (Task 1), 서버 제어 메시지 (Task 3)
- Produces:
  - `export class RelayWebSocketTransport implements CoopTransport` — `constructor(relayUrl: string, createSocket: (url: string) => WebSocket = url => new WebSocket(url))`
    - `host()`: `${relayUrl}?role=host` 접속, `relay:code` 수신 시 `{ joinCode: code }`로 resolve, 상태 `"waitingForPeer"`. `relay:paired` 시 `"connected"`.
    - `join(code)`: `?code=${code}` 접속, `relay:paired`에 resolve, `relay:error`에 `new CoopRelayError(reason)`으로 reject.
    - `relay:peerLeft` 수신 시 상태 `"reconnecting"`. 상대 재입장으로 `relay:paired`가 다시 오면 `"connected"`.
    - 자기 소켓이 예기치 않게 끊기면 상태 `"reconnecting"`, 2초 간격으로 `?code=X&rejoin=<내 역할>` 재접속 시도, 60초 지나면 `"closed"`.
    - `relay:` 아닌 프레임은 `decodeCoopMessage`로 풀어 핸들러에 전달. `null`이면 `console.warn` 후 버린다.
  - `export class CoopRelayError extends Error { readonly reason: "notFound" | "full" | "badRequest" }`
  - `export function parseJoinInput(input: string, defaultRelayUrl: string): { relayUrl: string; code: string } | null` — `"192.168.0.10:8787/abcd12"`처럼 `/` 앞에 호스트가 있으면 `relayUrl = "ws://192.168.0.10:8787"`, 아니면 `defaultRelayUrl`. 코드는 `normalizeJoinCode`로 정규화, 실패 시 `null`.
  - `export function getDefaultRelayUrl(): string | undefined` — `import.meta.env.VITE_COOP_RELAY_URL`.

- [x] **Step 1: 실패하는 테스트 작성** — `createSocket`에 가짜 소켓(`send` 기록, `emitMessage(text)`, `emitClose()` 제공)을 주입한다. `vi.useFakeTimers()` 사용. 테스트 이름과 단언:
  - `host resolves with the relay code`: 가짜 소켓 URL이 `wss://relay.test?role=host`, `relay:code` 주입 후 `{ joinCode: "ABC123" }`.
  - `join rejects with the relay error`: `relay:error notFound` 주입 → `CoopRelayError`, `reason === "notFound"`.
  - `buffers messages until the first handler subscribes`: paired 후 게임 메시지 주입, 나중에 등록한 핸들러가 받음.
  - `reconnects with rejoin after an unexpected close`: `emitClose()` 후 상태 `"reconnecting"`, `2_000`ms 진행 시 새 소켓 URL이 `...?code=ABC123&rejoin=host`.
  - `gives up after sixty seconds`: 재접속 소켓도 계속 닫히게 하고 `60_000`ms 진행 시 상태 `"closed"`.
  - `parseJoinInput handles local addresses and messy codes`: `parseJoinInput("192.168.0.10:8787/ ab-c123", "wss://r")`가 `{ relayUrl: "ws://192.168.0.10:8787", code: "ABC123" }`; `parseJoinInput("abc123", "wss://r")`가 `{ relayUrl: "wss://r", code: "ABC123" }`; `parseJoinInput("x/12", "wss://r")`는 `null`.
- [x] **Step 2: 실패 확인** — Run: `pnpm test test/tests/coop/relay-websocket-transport.test.ts` / Expected: FAIL
- [x] **Step 3: 구현**
- [x] **Step 4: 통과 확인** — 같은 명령 / Expected: PASS
- [x] **Step 5: 실제 서버로 수동 확인** — 한 터미널 `pnpm coop:local`, 다른 터미널에서 `node -e`로 `ws` 클라이언트 두 개를 띄워 `?role=host`와 `?code=<받은 코드>`로 접속해 서로 텍스트가 오가는지 본다. Expected: 양쪽 `relay:paired`와 전달된 텍스트 출력
- [x] **Step 6: 커밋** — `git commit -m "feat(coop): add relay websocket transport"`

---

### Task 5: 핸드셰이크

**Files:**
- Create: `src/coop/coop-handshake.ts`
- Test: `test/tests/coop/coop-handshake.test.ts`

**Interfaces:**
- Consumes: `CoopTransport` (Task 2), `COOP_PROTOCOL_VERSION`, `CoopMessage` (Task 1), `createLoopbackPair` (테스트)
- Produces:
  - `export async function performHandshake(transport: CoopTransport, local: { gameVersion: string; accountName: string }, timeoutMs = 15_000): Promise<{ peerAccountName: string }>` — 연결된 transport에서 `hello`를 보내고 상대 `hello`를 기다린다. `gameVersion`이나 `protocol`이 다르면 `bye`를 보내고 `close()` 후 `CoopVersionMismatchError`로 reject. 상대 상태가 `"closed"`가 되거나 타임아웃이면 `CoopHandshakeError`로 reject. 끝나면 자기가 등록한 구독을 해제한다.
  - `export class CoopVersionMismatchError extends Error { readonly localVersion: string; readonly peerVersion: string }`
  - `export class CoopHandshakeError extends Error {}`
  - 호출하는 쪽(3번 계획의 UI)은 `gameVersion`에 `#package.json`의 `version`을 넘긴다.

- [x] **Step 1: 실패하는 테스트 작성** — loopback 쌍으로:
  - `exchanges account names`: 양쪽 `performHandshake`가 각각 상대 이름을 돌려준다.
  - `rejects mismatched game versions on both sides`: `"1.12.1.0"`과 `"1.12.2.0"` → 양쪽 모두 `CoopVersionMismatchError`, 오류에 두 버전이 담김.
  - `rejects when the peer closes before hello`: 게스트가 hello 없이 `close()` → 호스트가 `CoopHandshakeError`.
  - `times out`: `vi.useFakeTimers()`, 상대가 아무것도 안 보내면 `15_000`ms 후 `CoopHandshakeError`.
- [x] **Step 2: 실패 확인** — Run: `pnpm test test/tests/coop/coop-handshake.test.ts` / Expected: FAIL
- [x] **Step 3: 구현**
- [x] **Step 4: 통과 확인** — 같은 명령 / Expected: PASS
- [x] **Step 5: 커밋** — `git commit -m "feat(coop): add version handshake"`

---

### Task 6: CoopOwnership과 CoopSession 뼈대

**Files:**
- Create: `src/coop/coop-ownership.ts`, `src/coop/coop-session.ts`
- Test: `test/tests/coop/coop-session.test.ts`

**Interfaces:**
- Consumes: `CoopRole`, `CoopMessage` (Task 1), `CoopTransport` (Task 2)
- Produces:
  - `export const COOP_MAX_OWNED = 3;` (스펙 3.2: 각자 최대 3마리)
  - `export class CoopOwnership` — `set(pokemonId: number, owner: CoopRole): void`, `get(pokemonId: number): CoopRole | undefined`, `remove(pokemonId: number): void`, `countOwnedBy(owner: CoopRole, partyIds: readonly number[]): number`(파티에 아직 있는 것만 셈), `toJSON(): Record<number, CoopRole>`, `static fromJSON(data: Record<number, CoopRole>): CoopOwnership`
  - `export class CoopSession` — `constructor(readonly localRole: CoopRole, readonly transport: CoopTransport, readonly ownership = new CoopOwnership())`; `get remoteRole(): CoopRole`; `pickerForWave(waveIndex: number): CoopRole`(홀수 웨이브 호스트, 짝수 게스트, 스펙 3.5); `isLocalPicker(waveIndex: number): boolean`; `isLocallyOwned(pokemonId: number): boolean`
  - `export let coopSession: CoopSession | null = null;` `export function setCoopSession(session: CoopSession | null): void` — 이후 모든 협동 분기는 `coopSession?.`로 시작한다(스펙 4.3).

- [x] **Step 1: 실패하는 테스트 작성**
  - `alternates the reward picker by wave`: `pickerForWave(1) === "host"`, `pickerForWave(2) === "guest"`, `pickerForWave(200) === "guest"`.
  - `counts only owned pokemon still in the party`: id 1,2,3 host, 4 guest 등록 → `countOwnedBy("host", [1, 2, 4]) === 2`.
  - `round-trips ownership through JSON`: `CoopOwnership.fromJSON(JSON.parse(JSON.stringify(o))).get(4) === "guest"`.
  - `exposes the session globally`: `setCoopSession(s)` 후 `coopSession === s`, `setCoopSession(null)` 후 `null`. (`afterEach`에서 `null`로 초기화)
- [x] **Step 2: 실패 확인** — Run: `pnpm test test/tests/coop/coop-session.test.ts` / Expected: FAIL
- [x] **Step 3: 구현**
- [x] **Step 4: 전체 확인** — Run: `pnpm test test/tests/coop && pnpm typecheck && pnpm biome:ci && pnpm exec ls-lint && pnpm coop:server:test` / Expected: 모두 통과
- [ ] **Step 5: 기존 테스트 회귀 확인** — Run: `pnpm test:silent` / Expected: 이 계획 전과 같은 결과(코어 변경이 없으므로 새 실패 없음)
- [x] **Step 6: 커밋** — `git commit -m "feat(coop): add session and ownership skeleton"`

---

## 구현 메모 (계획과 달라진 점)

구현하면서 계획과 다르게 정한 부분이다. 2번 계획은 이 내용을 기준으로 작성한다.

1. **버퍼링 규칙 확장**: "첫 핸들러 등록 전까지"가 아니라 "구독 중인 핸들러가 하나도 없는 동안" 도착한 메시지를 버퍼에 쌓는다. 핸드셰이크가 끝나 구독을 해제한 직후, 다음 구독자가 붙기 전에 상대가 보낸 메시지(예: `starters`)를 잃지 않기 위해서다. 공통 처리는 `CoopTransportListeners`(`src/coop/coop-transport.ts`)에 있다.
2. **Loopback close 순서**: `close()` 시 상대에게 가는 `"closed"` 알림은 이미 보낸 메시지 뒤에 도착한다(실제 네트워크와 같은 순서). 그래서 상대 상태 변화는 `close()` 직후 동기적으로 보이지 않고 마이크로태스크 뒤에 보인다.
3. **중계 서버가 `relay:` 프레임을 걸러냄**: 클라이언트가 보낸 프레임의 `t`가 `relay:`로 시작하면 상대에게 전달하지 않는다. 상대가 제어 메시지를 위조하지 못하게 하려는 것이다. 그 외 프레임은 그대로 전달한다.
4. **재접속 중 `full` 오류는 재시도**: 서버가 이전 소켓의 끊김을 아직 감지하지 못하면 재입장이 `full`로 거절될 수 있으므로, 재접속 중에는 `full`이면 계속 재시도한다. `notFound`면 방이 만료된 것이므로 즉시 `"closed"`.
5. **끊긴 동안 보낸 메시지는 버린다**: `RelayWebSocketTransport.send`는 소켓이 열려 있지 않으면 메시지를 버린다. 재접속 후 상태 맞추기는 6번 계획(세이브와 재접속)에서 다룬다.
6. **`coop-server` 설치**: 루트 `pnpm-workspace.yaml` 때문에 `pnpm --dir coop-server install`이 루트를 설치하는 문제가 있어, `coop-server/pnpm-workspace.yaml`(`minimumReleaseAge` 포함)을 두어 독립 워크스페이스로 만들었다. 타입 검사용 `coop-server/tsconfig.json`과 루트 스크립트 `coop:server:typecheck`를 추가했다.
7. **lint 예외**: 루트 biome가 `node:test` import를 막으므로 서버 테스트 두 파일에 사유를 단 `biome-ignore`를 붙였다(`biome.jsonc`는 그대로). `.ls-lint.yml` ignore에 `coop-server/node_modules`를 추가했다.
8. **Node 버전**: 이 작업 환경은 Node 22.22였고, 22.18부터 타입 제거 실행이 기본이라 서버와 테스트가 그대로 동작했다. `engines`는 계획대로 `>=24`다.
