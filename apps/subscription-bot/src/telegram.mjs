import { config } from './config.mjs';

const apiBase = `https://api.telegram.org/bot${config.token}`;

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
}

export function trimText(value, max) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export async function api(method, payload = {}, options = {}) {
  const response = await fetch(`${apiBase}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: options.signal || AbortSignal.timeout((config.telegramLongPollSeconds + 10) * 1000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    const message = body?.description || `${response.status} ${response.statusText}`;
    const error = new Error(`Telegram ${method}: ${message}`);
    error.errorCode = body?.error_code;
    throw error;
  }
  return body.result;
}

export function mainKeyboard(language, t) {
  return {
    inline_keyboard: [
      [{ text: t(language, 'apartments'), url: `${config.sitePublicUrl}/flat-finder` }],
      [{ text: t(language, 'jobs'), url: `${config.sitePublicUrl}/jobs` }],
      [{ text: t(language, 'candidates'), url: `${config.sitePublicUrl}/hiring` }],
      [{ text: t(language, 'mySubscriptions'), callback_data: 'subs' }],
      [
        { text: t(language, 'language'), callback_data: 'language' },
        { text: t(language, 'help'), callback_data: 'help' },
      ],
    ],
  };
}

export async function sendText(chatId, text, replyMarkup) {
  return api('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

export async function editText(chatId, messageId, text, replyMarkup) {
  try {
    return await api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  } catch (error) {
    if (/message is not modified/i.test(error.message)) return null;
    throw error;
  }
}

export async function answerCallback(id, text) {
  return api('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
}

export async function leaveChat(chatId) {
  try { await api('leaveChat', { chat_id: chatId }); } catch { /* best effort */ }
}

export async function sendFlat(chatId, item, caption, keyboard) {
  const photos = [...new Set([item.photo, ...(item.photos || [])].filter(Boolean))].slice(0, 10);
  if (!photos.length) return sendText(chatId, caption, keyboard);

  if (photos.length === 1) {
    try {
      return await api('sendPhoto', {
        chat_id: chatId,
        photo: photos[0],
        caption: trimText(caption, 1024),
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
    } catch (error) {
      console.warn('[subscription-bot] sendPhoto fallback:', error.message);
      return sendText(chatId, caption, keyboard);
    }
  }

  try {
    await api('sendMediaGroup', {
      chat_id: chatId,
      media: photos.map((photo, index) => ({
        type: 'photo',
        media: photo,
        ...(index === 0 ? { caption: trimText(caption, 1024), parse_mode: 'HTML' } : {}),
      })),
    });
    return sendText(chatId, '↗️', keyboard);
  } catch (error) {
    console.warn('[subscription-bot] sendMediaGroup fallback:', error.message);
    return sendText(chatId, caption, keyboard);
  }
}
