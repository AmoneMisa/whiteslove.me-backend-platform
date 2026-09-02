// Telegram-specific room/share signals that are too colloquial to infer from
// generic apartment vocabulary alone. Keep these conservative: audience-only
// restrictions (for example "faqat qizlar") are not enough to mark a whole
// apartment as room-only; the post must explicitly advertise a place/bed/room.
export function looksTelegramRoomShare(text) {
  if (!text) return false;

  const value = String(text).replace(/\s+/g, ' ').trim();
  if (!value) return false;

  return /(?:qiz(?:lar(?:ga)?|lar\s+uchun)?|ayol(?:lar(?:ga)?|lar\s+uchun)?|talaba(?:lar(?:ga)?|lar\s+uchun)?)[^.!?\r\n]{0,40}\bjoy\s+(?:bor|mavjud)\b|\bjoy\s+(?:bor|mavjud)\b[^.!?\r\n]{0,40}(?:qiz(?:lar(?:ga)?)?|ayol(?:lar(?:ga)?)?|talaba(?:lar(?:ga)?)?)|(?:қиз(?:лар(?:га)?|лар\s+учун)?|аёл(?:лар(?:га)?|лар\s+учун)?|талаба(?:лар(?:га)?|лар\s+учун)?)[^.!?\r\n]{0,40}жой\s+(?:бор|мавжуд)|жой\s+(?:бор|мавжуд)[^.!?\r\n]{0,40}(?:қиз(?:лар(?:га)?)?|аёл(?:лар(?:га)?)?|талаба(?:лар(?:га)?)?)|койко[-\s]?мест|место\s+в\s+(?:комнат|квартир)|bed\s+space/i.test(value);
}
