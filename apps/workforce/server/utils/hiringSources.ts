// Compatibility facade. Canonical Telegram hiring runtime lives under server/hiring.
// hiringChannelHandles is implemented there with filter((channel) => channel.enabled !== false).
export { fetchHiringChannel, hiringChannelHandles } from '../hiring/sources/telegramRuntime'
export type { ChannelFunnel, ChannelOutcome } from '../hiring/sources/telegramRuntime'
export { getHiringSourceDiagnostics } from '../hiring/sources/telegramDiagnostics'
export type { HiringSourceDiagnostic } from '../hiring/sources/telegramDiagnostics'
