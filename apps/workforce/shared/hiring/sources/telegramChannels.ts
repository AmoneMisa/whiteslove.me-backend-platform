export interface HiringTelegramChannelDescriptor {
  handle: string
  label: string
  country: 'UZ' | 'KZ' | 'KG' | 'UA'
  location: string
  tags: string[]
  cvFeed?: boolean
  includeAny?: string[]
  requireCandidateMarker?: boolean
  enabled?: boolean
  priority?: 'high' | 'normal' | 'low'
  historyLimit?: number
}

/**
 * Canonical Telegram hiring source catalog.
 *
 * This module contains only source policy/metadata. Transport, parsing,
 * diagnostics, cursors and persistence belong to the server hiring layer.
 */
export const HIRING_TELEGRAM_CHANNELS: readonly HiringTelegramChannelDescriptor[] = [
  { handle: 'ISH_QIDIR', label: 'Ish Qidir', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 3_000 },
  { handle: 'myrabota_uz', label: 'Работа в Ташкенте', country: 'UZ', location: 'Tashkent', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 2_000 },
  { handle: 'ish_uz', label: 'Ish.uz', country: 'UZ', location: 'Tashkent', tags: ['Resume', 'Mass market', 'Tashkent'], requireCandidateMarker: true, historyLimit: 5_000, priority: 'high' },
  { handle: 'UzJobs', label: 'UzJobs', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 5_000 },
  { handle: 'uzb_vakansiya', label: 'UZB Vakansiya', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 3_000 },
  { handle: 'ishchi', label: 'ISHCHI', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 3_000 },
  { handle: 'freelancer_Uzbek', label: 'Freelancer Uz', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Freelance', 'Digital', 'Creative'], requireCandidateMarker: true, historyLimit: 5_000, priority: 'high' },
  { handle: 'Jobs_uz_vacancy', label: 'Jobs Uz', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Mass market', 'Digital'], requireCandidateMarker: true, historyLimit: 5_000, priority: 'high' },
  { handle: 'hrangels', label: 'HR ANGELS', country: 'UZ', location: 'Tashkent', tags: ['Resume', 'HR', 'Operations', 'Tashkent'], requireCandidateMarker: true, historyLimit: 3_000, priority: 'high' },
  { handle: 'ishbor_olx_uz', label: 'OLX.UZ Ish', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 5_000, enabled: false },
  { handle: 'ISH_QAYERDA', label: 'Ish Qayerda', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Education'], requireCandidateMarker: true, historyLimit: 3_000 },
  { handle: 'UstozShogird', label: 'Ustoz Shogird', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'IT', 'Student'], requireCandidateMarker: true, historyLimit: 3_000, priority: 'high' },
  { handle: 'TALIMDAN_ISH_TOPISH', label: 'Taʼlimdan ish topish', country: 'UZ', location: 'Tashkent', tags: ['Resume', 'Education'], requireCandidateMarker: true, historyLimit: 3_000 },
  { handle: 'SAMARQAND_ISH', label: 'Samarqand ish', country: 'UZ', location: 'Samarkand', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 2_000, enabled: false },
  { handle: 'Fargona_ishlar', label: 'Fargona ishlar', country: 'UZ', location: 'Fergana', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 2_000 },
  { handle: 'Ishga_marhamat_andijon_elonlar', label: 'Andijon ish', country: 'UZ', location: 'Andijan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 2_000, enabled: false },
  { handle: 'namanganishbor', label: 'Namangan ish', country: 'UZ', location: 'Namangan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 2_000, enabled: false },
  { handle: 'buxoroda_ish', label: 'Buxoroda ish', country: 'UZ', location: 'Bukhara', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 2_000, enabled: false },
  { handle: 'Xorazm_ish', label: 'Xorazm ish', country: 'UZ', location: 'Uzbekistan', tags: ['Resume', 'Mass market'], requireCandidateMarker: true, historyLimit: 2_000 },
  { handle: 'workitkz', label: 'workITkz', country: 'KZ', location: 'Kazakhstan', tags: ['Resume', 'IT'], historyLimit: 1_500, enabled: false },
  { handle: 'jobslbish', label: 'Jobs.bish', country: 'KG', location: 'Bishkek', tags: ['Resume', 'Mass market'], historyLimit: 1_500, priority: 'low' },
  { handle: 'Cvflow', label: 'CV Flow', country: 'KG', location: 'Kyrgyzstan', tags: ['Resume', 'IT'], cvFeed: true, includeAny: ['kyrgyzstan', 'кыргызстан', 'bishkek', 'бишкек', 'osh', 'ош'], historyLimit: 1_500 },
  { handle: 'itcandidatesUA', label: 'IT Candidates UA', country: 'UA', location: 'Ukraine', tags: ['Resume', 'IT'], cvFeed: true, historyLimit: 1_500 },
  { handle: 'hr_recruiter_ua', label: 'HR & Recruiters UA', country: 'UA', location: 'Ukraine', tags: ['Resume', 'HR'], historyLimit: 1_500 },
] as const

export function hiringTelegramChannelHandles(): string[] {
  return HIRING_TELEGRAM_CHANNELS
    .filter((channel) => channel.enabled !== false)
    .map((channel) => channel.handle)
}

export function findHiringTelegramChannel(handle: string): HiringTelegramChannelDescriptor | undefined {
  const normalized = handle.replace(/^@/, '').toLowerCase()
  return HIRING_TELEGRAM_CHANNELS.find((channel) => channel.handle.toLowerCase() === normalized)
}
