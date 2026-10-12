/**
 * Text for the co-op screens.
 *
 * Translations live in the separate locales repository, which co-op does not modify. Each text is looked up under
 * the `coop` namespace, so a translation added there later wins, and otherwise falls back to the built-in
 * Korean or English text below.
 * @module
 */

import i18next, { type TOptions } from "i18next";

const COOP_TEXT = {
  coopPlay: { en: "Co-op Play", ko: "협동 플레이" },
  hostGame: { en: "Host", ko: "호스트" },
  joinGame: { en: "Join", ko: "참가" },
  joinTitle: { en: "Join Co-op", ko: "협동 참가" },
  joinCodeLabel: { en: "Join Code", ko: "참가 코드" },
  gettingJoinCode: { en: "Getting a join code...", ko: "참가 코드를 받는 중..." },
  waitingForPartner: {
    en: "Join code: {{code}}\nWaiting for your partner to join...",
    ko: "참가 코드: {{code}}\n파트너가 들어오기를 기다리는 중...",
  },
  connecting: { en: "Connecting...", ko: "연결하는 중..." },
  invalidCode: { en: "That join code is not valid.", ko: "참가 코드가 올바르지 않습니다." },
  codeNotFound: { en: "No game was found for that code.", ko: "그 코드의 게임을 찾을 수 없습니다." },
  roomFull: { en: "That game already has two players.", ko: "이미 두 명이 들어간 게임입니다." },
  versionMismatch: {
    en: "Game versions differ (yours {{local}}, partner {{peer}}).",
    ko: "게임 버전이 다릅니다 (내 버전 {{local}}, 파트너 {{peer}}).",
  },
  connectionFailed: { en: "Could not connect to your partner.", ko: "파트너와 연결하지 못했습니다." },
  partnerPicking: { en: "Partner: picking", ko: "파트너: 고르는 중" },
  partnerReady: { en: "Partner: ready", ko: "파트너: 준비 완료" },
  waitingForReady: {
    en: "Waiting for your partner...\nPress cancel to pick again.",
    ko: "파트너를 기다리는 중...\n다시 고르려면 취소를 누르세요.",
  },
  partnerLeft: { en: "Your partner left.", ko: "파트너가 나갔습니다." },
} as const satisfies Record<string, { en: string; ko: string }>;

export type CoopTextKey = keyof typeof COOP_TEXT;

/** Translate a co-op text, falling back to the built-in Korean or English text when no translation exists. */
export function coopText(key: CoopTextKey, options: TOptions = {}): string {
  const language = i18next.language ?? "en";
  const text = COOP_TEXT[key];
  return i18next.t(`coop:${key}`, { ...options, defaultValue: language.startsWith("ko") ? text.ko : text.en });
}
