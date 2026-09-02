import test from 'node:test';
import assert from 'node:assert/strict';

import { COUNTRIES } from '../src/geo/countries.js';
import { telegramHousingChannels } from '../src/sources/telegram-housing-sources.js';
import { buildCrawlPlan } from '../src/scheduling/queuePlan.js';

test('Romania keeps live general feeds alongside owner sources', () => {
  const channels = telegramHousingChannels('RO', COUNTRIES.RO.telegramChannels);
  const byName = (name) => channels.find((channel) => channel?.name === name);

  for (const [name, city] of [
    ['bucharest_homes', 'Bucharest'],
    ['apartamenti_bucharest', 'Bucharest'],
    ['kvartirabrasov1', 'Brasov'],
  ]) {
    assert.equal(byName(name)?.city, city, name);
    assert.notEqual(byName(name)?.ownerOnly, true, name);
  }

  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  for (const name of ['bucharest_homes', 'apartamenti_bucharest', 'kvartirabrasov1']) {
    assert.ok(tasks.some((task) =>
      task.type === 'flat.telegram.channel'
      && task.country === 'RO'
      && task.channel === name
      && task.ownerOnly !== true,
    ), name);
  }
});

test('Ukraine keeps dedicated owner feeds without suppressing mixed channels', () => {
  const channels = telegramHousingChannels('UA', COUNTRIES.UA.telegramChannels);
  const byName = (name) => channels.find((channel) => channel?.name === name);

  for (const [name, city] of [
    ['direct_rent', 'Lviv'],
    ['direct_rent_cv', 'Chernivtsi'],
    ['direct_rent_rivne', 'Rivne'],
    ['lviv_no_maklers', 'Lviv'],
    ['BEZ_rieltoriv_DP', 'Dnipro'],
    ['LUTSK_ORENDA', 'Lutsk'],
    ['Ternopol_arenda', 'Ternopil'],
  ]) {
    assert.equal(byName(name)?.city, city, name);
    assert.equal(byName(name)?.ownerOnly, true, name);
  }

  // Mixed feeds must stay mixed so owner and realtor listings remain visible.
  for (const name of ['KH_Rent', 'rent_frankivsk', 'SMARTIN_MYKOLAYIV', 'rentin_khmelnytskyi']) {
    assert.notEqual(byName(name)?.ownerOnly, true, name);
  }

  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  for (const name of [
    'direct_rent',
    'direct_rent_cv',
    'direct_rent_rivne',
    'lviv_no_maklers',
    'BEZ_rieltoriv_DP',
    'LUTSK_ORENDA',
    'Ternopol_arenda',
  ]) {
    assert.ok(tasks.some((task) =>
      task.type === 'flat.telegram.channel'
      && task.country === 'UA'
      && task.channel === name
      && task.ownerOnly === true,
    ), name);
  }

  for (const name of ['KH_Rent', 'rent_frankivsk', 'SMARTIN_MYKOLAYIV', 'rentin_khmelnytskyi']) {
    assert.ok(tasks.some((task) =>
      task.type === 'flat.telegram.channel'
      && task.country === 'UA'
      && task.channel === name
      && task.ownerOnly !== true,
    ), name);
  }
});

test('Kazakhstan adds owner and mixed regional feeds side by side', () => {
  const channels = telegramHousingChannels('KZ', COUNTRIES.KZ.telegramChannels);
  const byName = (name) => channels.find((channel) => channel?.name === name);

  assert.equal(byName('arenda_kvartiry_astana')?.ownerOnly, true);
  assert.equal(byName('arenda_kvartiry_astana')?.city, 'Astana');
  assert.notEqual(byName('rentinastana')?.ownerOnly, true);
  assert.equal(byName('rentinastana')?.city, 'Astana');
  assert.notEqual(byName('kvartira_v_almaty')?.ownerOnly, true);

  for (const [name, city] of [
    ['arendaktobe', 'Aktobe'],
    ['arenda_karaganda_kvartira', 'Karaganda'],
    ['atyraukvortira', 'Atyrau'],
    ['kvartiraoral', 'Oral'],
  ]) {
    assert.equal(byName(name)?.city, city, name);
    assert.notEqual(byName(name)?.ownerOnly, true, name);
  }

  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  assert.ok(tasks.some((task) =>
    task.type === 'flat.telegram.channel'
    && task.country === 'KZ'
    && task.channel === 'arenda_kvartiry_astana'
    && task.ownerOnly === true,
  ));
  for (const name of [
    'rentinastana',
    'arendaktobe',
    'arenda_karaganda_kvartira',
    'atyraukvortira',
    'kvartiraoral',
  ]) {
    assert.ok(tasks.some((task) =>
      task.type === 'flat.telegram.channel'
      && task.country === 'KZ'
      && task.channel === name
      && task.ownerOnly !== true,
    ), name);
  }
});

test('Kyrgyzstan keeps mixed Bishkek and expands Osh public feeds', () => {
  const kg = telegramHousingChannels('KG', COUNTRIES.KG.telegramChannels);
  const byName = (name) => kg.find((channel) => channel?.name === name);

  const bishkek = byName('bishkekarendakv');
  assert.equal(bishkek?.city, 'Bishkek');
  assert.notEqual(bishkek?.ownerOnly, true);
  assert.equal(byName('kvartira_osh')?.city, 'Osh');
  assert.notEqual(byName('kvartira_osh')?.ownerOnly, true);
  assert.equal(byName('arendaosh')?.city, 'Osh');
  assert.notEqual(byName('arendaosh')?.ownerOnly, true);

  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  for (const name of ['bishkekarendakv', 'kvartira_osh', 'arendaosh']) {
    assert.ok(tasks.some((task) =>
      task.type === 'flat.telegram.channel'
      && task.country === 'KG'
      && task.channel === name
      && task.ownerOnly !== true,
    ), name);
  }
});

test('Uzbekistan keeps mixed Tashkent and adds live regional coverage', () => {
  const uz = telegramHousingChannels('UZ', COUNTRIES.UZ.telegramChannels);
  const byName = (name) => uz.find((channel) => channel?.name === name);

  assert.ok(uz.some((channel) => channel === 'arentash'));
  assert.ok(!uz.some((channel) => channel?.name === 'arentash' && channel.ownerOnly === true));

  assert.equal(byName('arenda_kvartir_buxara')?.city, 'Bukhara');
  assert.equal(byName('arenda_kvartir_buxara')?.ownerOnly, true);
  assert.equal(byName('arenda_samarkand_etagi')?.city, 'Samarkand');
  assert.equal(byName('arenda_samarkand_etagi')?.dealType, 'shortRent');

  for (const [name, city] of [
    ['namangan_ijara_kvartiralar', 'Namangan'],
    ['Arenda_Kvartira_Fergane_1', 'Fergana'],
    ['farpi_ijara_kv', 'Fergana'],
    ['andijon_ijara_bor', 'Andijan'],
    ['ijara_arenda_uylari', 'Andijan'],
    ['kvartira_nukus', 'Nukus'],
  ]) {
    assert.equal(byName(name)?.city, city, name);
    assert.notEqual(byName(name)?.ownerOnly, true, name);
  }

  const daily = byName('kunlik_kvartira_1');
  assert.equal(daily?.city, 'Tashkent');
  assert.equal(daily?.dealType, 'shortRent');
  assert.equal(daily?.ownerOnly, true);
  assert.ok(daily?.ownerMarkers.includes('egasi'));
  assert.ok(daily?.ownerMarkers.includes('bezmakler'));

  const { tasks } = buildCrawlPlan({ shardCount: 2 });
  assert.ok(tasks.some((task) =>
    task.type === 'flat.telegram.channel'
    && task.country === 'UZ'
    && task.channel === 'arenda_kvartir_buxara'
    && task.ownerOnly === true,
  ));
  assert.ok(tasks.some((task) =>
    task.type === 'flat.telegram.channel'
    && task.country === 'UZ'
    && task.channel === 'kunlik_kvartira_1'
    && task.ownerOnly === true,
  ));
  for (const name of [
    'arenda_samarkand_etagi',
    'namangan_ijara_kvartiralar',
    'Arenda_Kvartira_Fergane_1',
    'farpi_ijara_kv',
    'andijon_ijara_bor',
    'ijara_arenda_uylari',
    'kvartira_nukus',
  ]) {
    assert.ok(tasks.some((task) =>
      task.type === 'flat.telegram.channel'
      && task.country === 'UZ'
      && task.channel === name,
    ), name);
  }
});
