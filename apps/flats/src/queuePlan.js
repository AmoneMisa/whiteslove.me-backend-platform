import { randomUUID } from 'node:crypto';
import { COUNTRIES } from './countries.js';
import { telegramHousingChannels } from './telegram-housing-sources.js';
import { realtorHousingSources } from './realtor-housing-sources.js';
import { ownerHousingSources } from './owner-housing-sources.js';
import { externalHousingSources } from './external-housing-sources.js';

export const QUEUE_PROTOCOL_VERSION = Math.max(
  3,
  Number(process.env.QUEUE_PROTOCOL_VERSION) || 3,
);

export const QUEUE_SHARDS = Math.max(
  1,
  Number(process.env.QUEUE_SHARDS) || 2,
);

function channelConfig(value) {
  if (typeof value === 'string') {
    return { name: value, city: null, dealType: null };
  }

  if (value && typeof value === 'object' && value.name) {
    return {
      name: String(value.name),
      city: value.city ? String(value.city) : null,
      dealType: value.dealType ? String(value.dealType) : null,
    };
  }

  return null;
}

function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function chainKey(task) {
  if (task.type === 'flat.olx.page') {
    return [
      task.country,
      task.citySlug || 'all',
      task.segment || 'all',
    ].join(':');
  }

  if (task.type === 'flat.telegram.channel') {
    return [
      task.country,
      'telegram',
      task.channel || 'unknown',
    ].join(':');
  }

  if (task.type === 'flat.custom.url') {
    return [
      task.country,
      'custom',
      task.segment || task.url || 'unknown',
    ].join(':');
  }

  return [task.country || 'unknown', task.type || 'unknown'].join(':');
}

export function crawlerShard(task, shardCount = QUEUE_SHARDS) {
  return stableHash(chainKey(task)) % Math.max(1, shardCount);
}

function versionTask(task, crawlGeneration, shardCount) {
  return {
    ...task,
    queueProtocol: QUEUE_PROTOCOL_VERSION,
    crawlGeneration,
    crawlerShard: crawlerShard(task, shardCount),
  };
}

export function taskPriority(task) {
  if (task.type === 'flat.olx.page') {
    if (task.country === 'UA' && task.page === 1 && task.city) return 10;
    if (task.ownerOnly) return 9;
    if (task.page === 1 && task.city) return 9;
    if (task.page === 1) return 7;
    return Math.max(1, 7 - task.page);
  }

  if (task.type === 'flat.telegram.channel') {
    if (
      task.country === 'UA' &&
      ['Lutsk', 'Chernivtsi', 'Uzhhorod', 'Mukachevo'].includes(task.city)
    ) {
      return 10;
    }
    return task.ownerOnly ? 9 : 8;
  }

  if (task.type === 'flat.custom.url') {
    return task.ownerOnly ? 8 : 6;
  }

  return 1;
}

function sourceTask(source, country, crawlGeneration, shardCount) {
  return versionTask({
    type: 'flat.custom.url',
    country,
    city: source.city || null,
    url: source.url,
    segment: source.key,
    dealType: source.dealType || null,
    curated: true,
    ownerOnly: source.ownerOnly === true,
    ownerMarkers: Array.isArray(source.ownerMarkers) ? [...source.ownerMarkers] : undefined,
    ownerRejectMarkers: Array.isArray(source.ownerRejectMarkers)
      ? [...source.ownerRejectMarkers]
      : undefined,
  }, crawlGeneration, shardCount);
}

export function buildCrawlPlan({ shardCount = QUEUE_SHARDS } = {}) {
  const tasks = [];
  const crawlGeneration = randomUUID();

  for (const country of Object.values(COUNTRIES)) {
    if (country.sources?.includes('olx')) {
      const segments = ['flat:longRent', 'flat:shortRent', 'flat:sale'];

      if (country.code === 'UA' && Array.isArray(country.olxCities)) {
        for (const target of country.olxCities) {
          for (const segment of segments) {
            const task = versionTask({
              type: 'flat.olx.page',
              country: country.code,
              city: target.city,
              citySlug: target.slug,
              segment,
              page: 1,
            }, crawlGeneration, shardCount);
            tasks.push({ ...task, priority: taskPriority(task) });
          }
        }

        for (const segment of segments) {
          const task = versionTask({
            type: 'flat.olx.page',
            country: country.code,
            city: null,
            citySlug: null,
            segment,
            page: 1,
          }, crawlGeneration, shardCount);
          tasks.push({ ...task, priority: taskPriority(task) });
        }
      } else {
        for (const segment of segments) {
          const task = versionTask({
            type: 'flat.olx.page',
            country: country.code,
            city: null,
            citySlug: null,
            segment,
            page: 1,
          }, crawlGeneration, shardCount);
          tasks.push({ ...task, priority: taskPriority(task) });
        }
      }
    }

    if (country.sources?.includes('telegram')) {
      for (const raw of telegramHousingChannels(country.code, country.telegramChannels ?? [])) {
        const channel = channelConfig(raw);
        if (!channel) continue;

        const task = versionTask({
          type: 'flat.telegram.channel',
          country: country.code,
          channel: channel.name,
          city: channel.city,
          ownerOnly: raw?.ownerOnly === true,
        }, crawlGeneration, shardCount);
        tasks.push({ ...task, priority: taskPriority(task) });
      }
    }

    for (const source of ownerHousingSources(country.code)) {
      const task = sourceTask({ ...source, ownerOnly: true }, country.code, crawlGeneration, shardCount);
      tasks.push({ ...task, priority: taskPriority(task) });
    }

    for (const source of realtorHousingSources(country.code)) {
      const task = sourceTask(source, country.code, crawlGeneration, shardCount);
      tasks.push({ ...task, priority: taskPriority(task) });
    }

    for (const source of externalHousingSources(country.code)) {
      const task = sourceTask(source, country.code, crawlGeneration, shardCount);
      tasks.push({ ...task, priority: taskPriority(task) });
    }
  }

  return {
    tasks,
    crawlGeneration,
    queueProtocol: QUEUE_PROTOCOL_VERSION,
    crawlerShards: shardCount,
  };
}
