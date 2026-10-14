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
  coopVictoryName: { en: "Co-op Champions", ko: "협동 챔피언" },
  statCoopRuns: { en: "Co-op Runs", ko: "협동 런" },
  statCoopWins: { en: "Co-op Wins", ko: "협동 클리어" },
  runHistorySoloTab: { en: "< Solo runs >", ko: "< 솔로 기록 >" },
  runHistoryCoopTab: { en: "< Co-op runs >", ko: "< 협동 기록 >" },
  runHistoryCoopMode: { en: "Co-op: {{partner}}", ko: "협동: {{partner}}" },
  coopVictoryDescription: {
    en: "Beat the game in classic mode with a partner",
    ko: "파트너와 함께 클래식 모드를 클리어",
  },
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
  waitingForPartnerReturn: {
    en: "Join code: {{code}}\nWaiting for your partner to come back...",
    ko: "참가 코드: {{code}}\n파트너가 돌아오기를 기다리는 중...",
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
  waitingForReady: { en: "Ready! Cancel to pick again", ko: "준비 완료! 취소로 다시 고르기" },
  partnerLeft: { en: "Your partner left.", ko: "파트너가 나갔습니다." },
  notEnoughPoints: { en: "Not enough points left. Pick again", ko: "남은 포인트가 부족합니다. 다시 고르기" },
  waitingForCommand: { en: "Waiting for your partner's command...", ko: "파트너의 입력을 기다리는 중..." },
  waitingForFleeAnswer: {
    en: "Waiting for your partner to agree to flee...",
    ko: "파트너가 도망에 동의하기를 기다리는 중...",
  },
  fleeProposal: {
    en: "Your partner wants to flee.\nFlee together?",
    ko: "파트너가 도망치려 합니다.\n같이 도망칠까요?",
  },
  waitingForPartnerChoice: { en: "Waiting for your partner to choose...", ko: "파트너가 고르는 중..." },
  partnerPokemon: {
    en: "{{pokemonName}} is your partner's Pokémon.",
    ko: "{{pokemonName}}은(는) 파트너의 포켓몬입니다.",
  },
  partnerPickingReward: {
    en: "Your partner picks the reward.\nChoose one to ping it.",
    ko: "파트너가 보상을 고르는 중\n고르면 핑을 보냅니다",
  },
  notEnoughMoney: { en: "You don't have enough money.", ko: "돈이 부족합니다." },
  partnerPingedOption: { en: "Your partner suggests: {{option}}", ko: "파트너: {{option}} 골라줘!" },
  partnerPingedEncounter: { en: "Your partner suggests option {{option}}!", ko: "파트너: {{option}}번 선택지 골라줘!" },
  ownerAsk: {
    en: "Your partner wants to use {{pokemonName}}. Allow it?",
    ko: "파트너가 {{pokemonName}}을(를) 고르려 합니다. 허락할까요?",
  },
  partnerOptionAsk: {
    en: "Your partner wants option {{option}}, which may affect your Pokémon. Allow it?",
    ko: "파트너가 {{option}}번 선택지를 고르려 합니다. 내 포켓몬에게 영향이 있을 수 있습니다. 허락할까요?",
  },
  waitingForOwner: { en: "Waiting for your partner to allow it...", ko: "파트너의 허락을 기다리는 중..." },
  ownerDeclined: { en: "Your partner did not allow it.", ko: "파트너가 허락하지 않았습니다." },
  partnerPinged: { en: "Your partner suggests this one!", ko: "파트너: 이거 골라줘!" },
  continueGame: { en: "Continue", ko: "이어하기" },
  loadingSavedRun: { en: "Loading the saved run...", ko: "저장된 협동 런을 불러오는 중..." },
  wrongPartnerJoined: {
    en: "Another account joined. Only the saved partner can continue this run.",
    ko: "다른 계정이 들어왔습니다. 저장된 파트너만 이어할 수 있습니다.",
  },
  notTheSavedPartner: {
    en: "You are not the partner saved with this run.",
    ko: "이 협동 세이브의 파트너 계정이 아닙니다.",
  },
  partnerReconnecting: {
    en: "Partner disconnected. Waiting... ({{seconds}}s)",
    ko: "파트너 연결 끊김. 재접속 대기 중... ({{seconds}}초)",
  },
  connectionLost: {
    en: "Your partner did not come back. Returning to the title screen.",
    ko: "파트너와 다시 연결되지 않았습니다. 타이틀로 돌아갑니다.",
  },
  partnerGone: {
    en: "Your partner did not come back. Keeping the game open for them.",
    ko: "파트너가 돌아오지 않았습니다. 파트너가 다시 들어올 수 있게 방을 유지합니다.",
  },
  partnerReturned: {
    en: "Your partner is back. Reconnecting...",
    ko: "파트너가 다시 들어왔습니다. 다시 연결하는 중...",
  },
  disconnected: {
    en: "The connection was lost. If your partner is still waiting, join again with code {{code}}.",
    ko: "연결이 끊겼습니다. 파트너가 기다리고 있다면 코드 {{code}}로 다시 참가하세요.",
  },
  partnerLeftRun: {
    en: "Your partner left. Returning to the title screen.",
    ko: "파트너가 나갔습니다. 타이틀로 돌아갑니다.",
  },
  partnerSavedAndQuit: {
    en: "Your partner chose save and quit. Returning to the title screen.",
    ko: "파트너가 세이브 후 나갔습니다. 타이틀로 돌아갑니다.",
  },
  saveAndQuitButton: { en: "[Menu] Save and quit", ko: "[메뉴] 세이브 후 나가기" },
  saveAndQuitConfirm: { en: "Press [Menu] again to save and quit", ko: "[메뉴]를 한 번 더 누르면 세이브 후 나갑니다" },
  savingAndQuitting: { en: "Saving and quitting...", ko: "세이브 후 나가는 중..." },
  desyncDetected: {
    en: "The two games no longer match. Saving and returning to the title screen.",
    ko: "두 게임의 상태가 달라졌습니다. 세이브 후 타이틀로 돌아갑니다.",
  },
  fleeDeclined: { en: "Your partner did not agree to flee.", ko: "파트너가 도망에 동의하지 않았습니다." },
} as const satisfies Record<string, { en: string; ko: string }>;

export type CoopTextKey = keyof typeof COOP_TEXT;

/** Translate a co-op text, falling back to the built-in Korean or English text when no translation exists. */
export function coopText(key: CoopTextKey, options: TOptions = {}): string {
  const language = i18next.language ?? "en";
  const text = COOP_TEXT[key];
  return i18next.t(`coop:${key}`, { ...options, defaultValue: language.startsWith("ko") ? text.ko : text.en });
}
