import type { CountryMeta } from '../contracts/hiring'

/**
 * Markets explicitly supported by candidate-source ingestion.
 * Runtime-neutral so API/UI metadata never depends on Telegram transport code.
 */
export const HIRING_COUNTRIES: readonly CountryMeta[] = [
  { code: 'UZ', name: 'Uzbekistan', currency: 'UZS', cities: ['Tashkent', 'Samarkand', 'Bukhara', 'Namangan', 'Andijan', 'Fergana', 'Qarshi', 'Nukus', 'Urgench', 'Khiva'] },
  { code: 'UA', name: 'Ukraine', currency: 'UAH', cities: ['Kyiv', 'Lviv', 'Odesa', 'Kharkiv', 'Dnipro', 'Vinnytsia', 'Zaporizhzhia'] },
  { code: 'KZ', name: 'Kazakhstan', currency: 'KZT', cities: ['Almaty', 'Astana', 'Shymkent', 'Karaganda', 'Atyrau', 'Aktobe'] },
  { code: 'KG', name: 'Kyrgyzstan', currency: 'KGS', cities: ['Bishkek', 'Osh', 'Karakol'] },
]
