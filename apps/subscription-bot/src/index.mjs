import { config, validateConfig } from './config.mjs';
import {
  claimHandoff,
  createEditSession,
  createSubscription,
  deleteSubscription,
  ensureSchema,
  getSubscription,
  getUser,
  hasDelivery,
  hasSubscriptionSeen,
  listEnabledSubscriptions,
  listUserSubscriptions,
  markDelivered,
  markSubscriptionInitialized,
  markSubscriptionSeen,
  primeSubscriptionSeen,
  renameSubscription,
  setSubscriptionEnabled,
  setUserLanguage,
  touchSubscription,
  updateSubscriptionSearch,
  upsertUser,
} from './db.mjs';
import {
  fetchSubscriptionItems,
  filterSummary,
  flatAvailability,
  itemCreatedAt,
  itemKey,
  parseSearchUrl,
} from './feeds.mjs';
import { kindLabel, normalizeLanguage, t } from './i18n.mjs';
import {
  answerCallback,
  api,
  editText,
  escapeHtml,
  leaveChat,
  mainKeyboard,
  sendFlat,
  sendText,
  trimText,
} from './telegram.mjs';

if (!config.enabled) {
  console.log('[subscription-bot] disabled; set TELEGRAM_SUBSCRIPTION_BOT_ENABLED=on to start it');
  setInterval(() => {}, 60 * 60_000);
  await new Promise(() => {});
}

validateConfig();
await ensureSchema();

const pending = new Map();
let nextOffset = 0;
let scanning = false;
let stopping = false;

function userLanguage(user, from) {
  return normalizeLanguage(user?.language || from?.language_code || 'ru');
}

async function ensureUser(from, chatId) {
  const existing = await getUser(from.id);
  const language = userLanguage(existing, from);
  return upsertUser(from, chatId, language);
}

function defaultSubscriptionName(language, kind, id) {
  return `${kindLabel(language, kind).replace(/^\S+\s*/, '')} #${id}`;
}

function subscriptionKeyboard(language, sub) {
  return {
    inline_keyboard: [
      [{ text: t(language, 'openSearch'), url: sub.search_url }],
      [{ text: t(language, 'edit'), callback_data: `edit:${sub.id}` }],
      [{ text: t(language, 'rename'), callback_data: `rename:${sub.id}` }],
      [{ text: sub.enabled ? t(language, 'pause') : t(language, 'resume'), callback_data: `toggle:${sub.id}` }],
      [{ text: t(language, 'delete'), callback_data: `delete:${sub.id}` }],
      [{ text: t(language, 'back'), callback_data: 'subs' }],
    ],
  };
}

function subscriptionText(language, sub) {
  return [
    `<b>#${sub.id} · ${escapeHtml(sub.name)}</b>`,
    `${escapeHtml(kindLabel(language, sub.kind))} · ${sub.enabled ? t(language, 'active') : t(language, 'paused')}`,
    `${t(language, 'filters')}: <code>${escapeHtml(filterSummary(sub.filters))}</code>`,
  ].join('\n');
}

async function showMain(chatId, language, messageId) {
  const text = `<b>${escapeHtml(t(language, 'choose'))}</b>\n\n${escapeHtml(t(language, 'welcome'))}`;
  const keyboard = mainKeyboard(language, t);
  if (messageId) return editText(chatId, messageId, text, keyboard);
  return sendText(chatId, text, keyboard);
}

async function showSubscriptions(chatId, userId, language, messageId) {
  const subs = await listUserSubscriptions(userId);
  if (!subs.length) {
    const keyboard = { inline_keyboard: [[{ text: t(language, 'back'), callback_data: 'main' }]] };
    const text = escapeHtml(t(language, 'noSubscriptions'));
    return messageId ? editText(chatId, messageId, text, keyboard) : sendText(chatId, text, keyboard);
  }
  const keyboard = {
    inline_keyboard: [
      ...subs.map((sub) => [{
        text: `${sub.enabled ? '🟢' : '⚪'} #${sub.id} ${trimText(sub.name, 36)}`,
        callback_data: `sub:${sub.id}`,
      }]),
      [{ text: t(language, 'back'), callback_data: 'main' }],
    ],
  };
  const text = `<b>${escapeHtml(t(language, 'mySubscriptions'))}</b>`;
  return messageId ? editText(chatId, messageId, text, keyboard) : sendText(chatId, text, keyboard);
}

async function showSubscription(chatId, userId, language, id, messageId) {
  const sub = await getSubscription(id, userId);
  if (!sub) return showSubscriptions(chatId, userId, language, messageId);
  const text = subscriptionText(language, sub);
  return messageId ? editText(chatId, messageId, text, subscriptionKeyboard(language, sub)) : sendText(chatId, text, subscriptionKeyboard(language, sub));
}

async function primeSubscription(sub) {
  const items = await fetchSubscriptionItems(sub);
  const keys = items.map((item) => itemKey(sub.kind, item)).filter(Boolean);
  await primeSubscriptionSeen(sub.id, keys);
  await markSubscriptionInitialized(sub.id);
  return keys.length;
}

async function createFromSearch(user, language, search) {
  const placeholder = `${kindLabel(language, search.kind).replace(/^\S+\s*/, '')}`;
  let sub = await createSubscription(user.telegram_user_id, search.kind, placeholder, search.searchUrl, search.filters);
  const name = defaultSubscriptionName(language, search.kind, sub.id);
  sub = await renameSubscription(sub.id, user.telegram_user_id, name);
  try {
    await primeSubscription(sub);
    return { sub, primed: true };
  } catch (error) {
    console.warn(`[subscription-bot] prime #${sub.id} failed:`, error.message);
    return { sub, primed: false };
  }
}

async function updateFromSearch(userId, sub, search) {
  if (search.kind !== sub.kind) return { sub: null, primed: false };
  const updated = await updateSubscriptionSearch(sub.id, userId, search.searchUrl, search.filters);
  if (!updated) return { sub: null, primed: false };
  try {
    await primeSubscription(updated);
    return { sub: updated, primed: true };
  } catch (error) {
    console.warn(`[subscription-bot] re-prime #${sub.id} failed:`, error.message);
    return { sub: updated, primed: false };
  }
}

function editSearchUrl(sub, editToken) {
  const url = new URL(sub.search_url);
  url.searchParams.set('_tgEdit', editToken);
  return url.toString();
}

async function showEditLink(chatId, userId, language, id, messageId) {
  const sub = await getSubscription(id, userId);
  if (!sub) return showSubscriptions(chatId, userId, language, messageId);
  const editToken = await createEditSession(id, userId);
  if (!editToken) return showSubscriptions(chatId, userId, language, messageId);
  const keyboard = {
    inline_keyboard: [
      [{ text: t(language, 'edit'), url: editSearchUrl(sub, editToken) }],
      [{ text: t(language, 'back'), callback_data: `sub:${id}` }],
    ],
  };
  const text = escapeHtml(t(language, 'editOnSite'));
  return messageId ? editText(chatId, messageId, text, keyboard) : sendText(chatId, text, keyboard);
}

async function applyWebsiteHandoff(chatId, user, language, value) {
  const claimed = await claimHandoff(value, user.telegram_user_id);
  if (!claimed) return sendText(chatId, escapeHtml(t(language, 'invalidHandoff')), mainKeyboard(language, t));
  if (claimed.forbidden) return sendText(chatId, escapeHtml(t(language, 'forbiddenHandoff')), mainKeyboard(language, t));

  let search;
  try {
    search = parseSearchUrl(claimed.searchUrl);
  } catch {
    return sendText(chatId, escapeHtml(t(language, 'invalidHandoff')), mainKeyboard(language, t));
  }

  if (claimed.subscriptionId) {
    const sub = await getSubscription(claimed.subscriptionId, user.telegram_user_id);
    if (!sub || sub.kind !== search.kind) return sendText(chatId, escapeHtml(t(language, 'invalidHandoff')), mainKeyboard(language, t));
    const result = await updateFromSearch(user.telegram_user_id, sub, search);
    if (!result.sub) return sendText(chatId, escapeHtml(t(language, 'error')), mainKeyboard(language, t));
    await sendText(chatId, escapeHtml(t(language, 'updated')));
    if (!result.primed) await sendText(chatId, escapeHtml(t(language, 'currentResultsFailed')));
    return showSubscription(chatId, user.telegram_user_id, language, sub.id);
  }

  const result = await createFromSearch(user, language, search);
  await sendText(chatId, escapeHtml(t(language, 'created')));
  if (!result.primed) await sendText(chatId, escapeHtml(t(language, 'currentResultsFailed')));
  return showSubscription(chatId, user.telegram_user_id, language, result.sub.id);
}

function commandId(parts) {
  const id = Number(parts[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

async function handlePrivateMessage(message) {
  const { chat, from } = message;
  if (!from || chat.type !== 'private') return;
  const user = await ensureUser(from, chat.id);
  const language = userLanguage(user, from);
  const text = String(message.text || '').trim();
  const parts = text.split(/\s+/).filter(Boolean);
  const command = parts[0]?.split('@')[0]?.toLowerCase();

  if (command === '/start') {
    pending.delete(from.id);
    const payload = parts[1] || '';
    if (payload.startsWith('sub_') && payload.length > 4) {
      return applyWebsiteHandoff(chat.id, user, language, payload.slice(4));
    }
    return showMain(chat.id, language);
  }
  if (command === '/menu') {
    pending.delete(from.id);
    return showMain(chat.id, language);
  }
  if (command === '/subscriptions') {
    pending.delete(from.id);
    return showSubscriptions(chat.id, from.id, language);
  }
  if (command === '/language') {
    return sendText(chat.id, escapeHtml(t(language, 'languagePick')), {
      inline_keyboard: [[
        { text: 'Русский', callback_data: 'lang:ru' },
        { text: 'English', callback_data: 'lang:en' },
      ]],
    });
  }
  if (command === '/help') return sendText(chat.id, escapeHtml(t(language, 'helpText')), mainKeyboard(language, t));

  if (['/pause', '/resume', '/unsubscribe', '/edit'].includes(command)) {
    const id = commandId(parts);
    if (!id) {
      await sendText(chat.id, escapeHtml(t(language, 'commandNeedsId')));
      return showSubscriptions(chat.id, from.id, language);
    }
    if (command === '/pause') {
      const sub = await setSubscriptionEnabled(id, from.id, false);
      if (!sub) return showSubscriptions(chat.id, from.id, language);
      await sendText(chat.id, escapeHtml(t(language, 'pausedDone')));
      return showSubscription(chat.id, from.id, language, id);
    }
    if (command === '/resume') {
      const sub = await setSubscriptionEnabled(id, from.id, true);
      if (!sub) return showSubscriptions(chat.id, from.id, language);
      try { await primeSubscription(sub); } catch (error) { console.warn(`[subscription-bot] resume prime #${id} failed:`, error.message); }
      await sendText(chat.id, escapeHtml(t(language, 'resumedDone')));
      return showSubscription(chat.id, from.id, language, id);
    }
    if (command === '/unsubscribe') {
      await deleteSubscription(id, from.id);
      await sendText(chat.id, escapeHtml(t(language, 'deleted')));
      return showSubscriptions(chat.id, from.id, language);
    }
    return showEditLink(chat.id, from.id, language, id);
  }

  const state = pending.get(from.id);
  if (!state) return showMain(chat.id, language);
  if (state.mode === 'rename') {
    const name = trimText(text, 80).trim();
    if (!name) return;
    const updated = await renameSubscription(state.id, from.id, name);
    pending.delete(from.id);
    if (!updated) return showSubscriptions(chat.id, from.id, language);
    await sendText(chat.id, escapeHtml(t(language, 'renamed')));
    return showSubscription(chat.id, from.id, language, updated.id);
  }
}

async function handleCallback(query) {
  const from = query.from;
  const message = query.message;
  if (!from || !message || message.chat.type !== 'private') {
    await answerCallback(query.id).catch(() => {});
    return;
  }
  const user = await ensureUser(from, message.chat.id);
  let language = userLanguage(user, from);
  const data = String(query.data || '');
  await answerCallback(query.id).catch(() => {});

  if (data === 'main') {
    pending.delete(from.id);
    return showMain(message.chat.id, language, message.message_id);
  }
  if (data === 'subs') {
    pending.delete(from.id);
    return showSubscriptions(message.chat.id, from.id, language, message.message_id);
  }
  if (data === 'help') {
    return editText(message.chat.id, message.message_id, escapeHtml(t(language, 'helpText')), {
      inline_keyboard: [[{ text: t(language, 'back'), callback_data: 'main' }]],
    });
  }
  if (data === 'language') {
    return editText(message.chat.id, message.message_id, escapeHtml(t(language, 'languagePick')), {
      inline_keyboard: [[
        { text: 'Русский', callback_data: 'lang:ru' },
        { text: 'English', callback_data: 'lang:en' },
      ], [{ text: t(language, 'back'), callback_data: 'main' }]],
    });
  }
  if (data.startsWith('lang:')) {
    language = data === 'lang:en' ? 'en' : 'ru';
    await setUserLanguage(from.id, language);
    return showMain(message.chat.id, language, message.message_id);
  }
  if (data.startsWith('sub:')) {
    pending.delete(from.id);
    return showSubscription(message.chat.id, from.id, language, Number(data.slice(4)), message.message_id);
  }
  if (data.startsWith('edit:')) {
    pending.delete(from.id);
    return showEditLink(message.chat.id, from.id, language, Number(data.slice(5)), message.message_id);
  }
  if (data.startsWith('rename:')) {
    const id = Number(data.slice(7));
    const sub = await getSubscription(id, from.id);
    if (!sub) return showSubscriptions(message.chat.id, from.id, language, message.message_id);
    pending.set(from.id, { mode: 'rename', id });
    return editText(message.chat.id, message.message_id, escapeHtml(t(language, 'askName')), {
      inline_keyboard: [[{ text: t(language, 'cancel'), callback_data: `sub:${id}` }]],
    });
  }
  if (data.startsWith('toggle:')) {
    const id = Number(data.slice(7));
    const existing = await getSubscription(id, from.id);
    if (!existing) return showSubscriptions(message.chat.id, from.id, language, message.message_id);
    const sub = await setSubscriptionEnabled(id, from.id, !existing.enabled);
    if (!sub) return showSubscriptions(message.chat.id, from.id, language, message.message_id);
    if (sub.enabled) {
      try { await primeSubscription(sub); } catch (error) { console.warn(`[subscription-bot] resume prime #${id} failed:`, error.message); }
    }
    return showSubscription(message.chat.id, from.id, language, id, message.message_id);
  }
  if (data.startsWith('delete:')) {
    const id = Number(data.slice(7));
    await deleteSubscription(id, from.id);
    pending.delete(from.id);
    await sendText(message.chat.id, escapeHtml(t(language, 'deleted')));
    return showSubscriptions(message.chat.id, from.id, language, message.message_id);
  }
}

function money(value, currency, language) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return `${new Intl.NumberFormat(language === 'en' ? 'en-US' : 'ru-RU', { maximumFractionDigits: 0 }).format(n)} ${currency || ''}`.trim();
}

function itemSiteUrl(subscription, item) {
  try {
    const url = new URL(subscription.search_url);
    if (subscription.kind === 'flats') {
      url.search = '';
      url.searchParams.set('flat', String(item.id || ''));
      if (item.source) url.searchParams.set('flatSource', String(item.source));
      if (item.country) url.searchParams.set('flatCountry', String(item.country));
    } else if (subscription.kind === 'jobs') {
      url.search = '';
      url.searchParams.set('job', String(item.id || ''));
    } else {
      url.search = '';
      url.searchParams.set('cv', String(item.id || ''));
      const source = item.sourceKey || item.origin || item.source;
      if (source) url.searchParams.set('cvSource', String(source));
      if (item.country) url.searchParams.set('cvCountry', String(item.country));
    }
    return url.toString();
  } catch {
    return subscription.search_url || null;
  }
}

function itemKeyboard(language, subscription, item) {
  const rows = [];
  const siteUrl = itemSiteUrl(subscription, item);
  if (siteUrl) rows.push([{ text: t(language, 'openSite'), url: siteUrl }]);
  const sourceUrl = item.url || item.applyUrl;
  if (sourceUrl && /^https?:\/\//i.test(sourceUrl)) rows.push([{ text: t(language, 'openSource'), url: sourceUrl }]);
  return { inline_keyboard: rows };
}

function flatCaption(language, sub, item) {
  const price = money(item.price, item.currency, language);
  const location = [item.city, item.district, item.metro].filter(Boolean).join(' · ');
  const details = [
    price,
    item.rooms != null ? `${item.rooms} ${t(language, 'rooms')}` : null,
    item.areaSqm != null ? `${item.areaSqm} m²` : null,
  ].filter(Boolean).join(' · ');
  const description = trimText(item.description || '', 430);
  return [
    `<b>${escapeHtml(item.title || t(language, 'noName'))}</b>`,
    details ? escapeHtml(details) : '',
    location ? `📍 ${escapeHtml(location)}` : '',
    description ? `\n${escapeHtml(description)}` : '',
    `\n🔔 ${escapeHtml(t(language, 'matched'))}: <b>${escapeHtml(sub.name)}</b>`,
  ].filter(Boolean).join('\n');
}

function jobText(language, sub, item) {
  const salary = item.salaryMin != null || item.salaryMax != null
    ? [money(item.salaryMin, item.salaryCurrency, language), money(item.salaryMax, item.salaryCurrency, language)].filter(Boolean).join(' – ')
    : null;
  const meta = [item.company, item.location, item.workMode, salary].filter(Boolean).join(' · ');
  return [
    `<b>${escapeHtml(item.title || t(language, 'noName'))}</b>`,
    meta ? escapeHtml(meta) : '',
    item.description ? `\n${escapeHtml(trimText(item.description, 1200))}` : '',
    `\n🔔 ${escapeHtml(t(language, 'matched'))}: <b>${escapeHtml(sub.name)}</b>`,
  ].filter(Boolean).join('\n');
}

function candidateText(language, sub, item) {
  const salary = item.salaryMin != null || item.salaryMax != null
    ? [money(item.salaryMin, item.currency, language), money(item.salaryMax, item.currency, language)].filter(Boolean).join(' – ')
    : null;
  const meta = [item.role, item.city, item.remote ? t(language, 'remoteShort') : null, salary].filter(Boolean).join(' · ');
  const skills = Array.isArray(item.skills) && item.skills.length ? item.skills.slice(0, 10).join(', ') : '';
  return [
    `<b>${escapeHtml(item.name || t(language, 'noName'))}</b>`,
    meta ? escapeHtml(meta) : '',
    skills ? `🧰 ${escapeHtml(skills)}` : '',
    item.description ? `\n${escapeHtml(trimText(item.description, 1000))}` : '',
    `\n🔔 ${escapeHtml(t(language, 'matched'))}: <b>${escapeHtml(sub.name)}</b>`,
  ].filter(Boolean).join('\n');
}

async function deliver(sub, item) {
  const language = normalizeLanguage(sub.language);
  const keyboard = itemKeyboard(language, sub, item);
  if (sub.kind === 'flats') return sendFlat(sub.chat_id, item, flatCaption(language, sub, item), keyboard);
  if (sub.kind === 'jobs') return sendText(sub.chat_id, jobText(language, sub, item), keyboard);
  return sendText(sub.chat_id, candidateText(language, sub, item), keyboard);
}

function isOlderThanSubscription(sub, item) {
  const created = itemCreatedAt(sub.kind, item);
  if (created == null) return false;
  const subCreated = Date.parse(sub.created_at);
  if (!Number.isFinite(subCreated)) return false;
  return created < subCreated - 120_000;
}

async function scanSubscription(sub) {
  if (!sub.initialized) {
    await primeSubscription(sub);
    return 0;
  }
  const items = await fetchSubscriptionItems(sub);
  let sent = 0;
  for (const item of [...items].reverse()) {
    if (sent >= config.maxNotificationsPerScan) break;
    const key = itemKey(sub.kind, item);
    if (!key || await hasDelivery(sub.telegram_user_id, sub.kind, key)) continue;
    if (await hasSubscriptionSeen(sub.id, key)) continue;

    if (isOlderThanSubscription(sub, item)) {
      await markSubscriptionSeen(sub.id, key);
      continue;
    }

    if (sub.kind === 'flats' && String(item.source || '').toLowerCase() === 'olx') {
      const availability = await flatAvailability(item);
      if (availability.status === 'inactive') {
        await markSubscriptionSeen(sub.id, key);
        continue;
      }
      if (config.flatRequireVerified && availability.status !== 'active') continue;
    }

    try {
      await deliver(sub, item);
      await markDelivered(sub.telegram_user_id, sub.kind, key, sub.id);
      sent += 1;
    } catch (error) {
      console.warn(`[subscription-bot] delivery ${key} failed:`, error.message);
      if (error.errorCode === 403) {
        await setSubscriptionEnabled(sub.id, sub.telegram_user_id, false).catch(() => {});
        break;
      }
    }
  }
  await touchSubscription(sub.id);
  return sent;
}

async function scanAll() {
  if (scanning || stopping) return;
  scanning = true;
  try {
    const subs = await listEnabledSubscriptions();
    for (const sub of subs) {
      try {
        await scanSubscription(sub);
      } catch (error) {
        console.warn(`[subscription-bot] scan #${sub.id} failed:`, error.message);
      }
    }
  } finally {
    scanning = false;
  }
}

async function processUpdate(update) {
  const chat = update.message?.chat || update.callback_query?.message?.chat || update.my_chat_member?.chat;
  if (chat && chat.type !== 'private') {
    await leaveChat(chat.id);
    return;
  }
  if (update.message) return handlePrivateMessage(update.message);
  if (update.callback_query) return handleCallback(update.callback_query);
}

async function pollingLoop() {
  while (!stopping) {
    try {
      const updates = await api('getUpdates', {
        offset: nextOffset,
        timeout: config.telegramLongPollSeconds,
        allowed_updates: ['message', 'callback_query', 'my_chat_member'],
      }, { signal: AbortSignal.timeout((config.telegramLongPollSeconds + 10) * 1000) });
      for (const update of updates) {
        nextOffset = Math.max(nextOffset, update.update_id + 1);
        try { await processUpdate(update); } catch (error) { console.error('[subscription-bot] update failed:', error); }
      }
    } catch (error) {
      if (!stopping) {
        console.warn('[subscription-bot] polling failed:', error.message);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
}

await api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
await api('setMyCommands', {
  commands: [
    { command: 'start', description: 'Open menu' },
    { command: 'subscriptions', description: 'My subscriptions' },
    { command: 'pause', description: 'Pause subscription: /pause ID' },
    { command: 'resume', description: 'Resume subscription: /resume ID' },
    { command: 'edit', description: 'Edit filters: /edit ID' },
    { command: 'unsubscribe', description: 'Unsubscribe: /unsubscribe ID' },
    { command: 'language', description: 'Language / Язык' },
    { command: 'help', description: 'Help' },
  ],
  scope: { type: 'all_private_chats' },
}).catch((error) => console.warn('[subscription-bot] setMyCommands failed:', error.message));

console.log(`[subscription-bot] started; scan every ${config.pollSeconds}s`);
const scanTimer = setInterval(() => void scanAll(), config.pollSeconds * 1000);
scanTimer.unref?.();
void scanAll();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    clearInterval(scanTimer);
  });
}

await pollingLoop();