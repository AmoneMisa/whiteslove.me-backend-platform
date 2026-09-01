import type { WebCvAdapter } from './common'
import { CAREERIST_SOURCE } from './careerist'
import { FLAGMA_SOURCES } from './flagma'
import { RABOTA_KZ_SOURCE } from './rabotaKz'
import { REGIONAL_PUBLIC_CV_ADAPTERS } from './regionalPublicBoards'
import { TALENT_SOURCE } from './talentUa'
import { WORK_UA_API_SOURCE } from './workUa'

export const WEB_ADAPTERS: Record<string, WebCvAdapter> = {
  ...FLAGMA_SOURCES,
  ...REGIONAL_PUBLIC_CV_ADAPTERS,
  [CAREERIST_SOURCE.key]: CAREERIST_SOURCE,
  [RABOTA_KZ_SOURCE.key]: RABOTA_KZ_SOURCE,
  [TALENT_SOURCE.key]: TALENT_SOURCE,
  [WORK_UA_API_SOURCE.key]: WORK_UA_API_SOURCE,
}

export function getWebAdapter(key: string): WebCvAdapter {
  const adapter = WEB_ADAPTERS[key]
  if (!adapter) throw new Error(`unknown web source: ${key}`)
  return adapter
}
