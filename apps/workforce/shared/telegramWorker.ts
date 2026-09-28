/**
 * Headers for the Telegram MTProto worker (Telegram-Worker-Userbot). Once the
 * worker has WORKER_API_KEY set it refuses requests without the same key in
 * X-Worker-Key; TG_WORKER_KEY holds it here, shared with flats.
 */
export function telegramWorkerHeaders(): Record<string, string> {
  const key = String(process.env.TG_WORKER_KEY || '').trim()
  return key ? { 'X-Worker-Key': key } : {}
}
