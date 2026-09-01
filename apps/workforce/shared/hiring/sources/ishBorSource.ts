export const ISHBOR_SOURCE_KEY = 'ishbor-uz'
export const ISHBOR_SOURCE_LABEL = 'IshBor'
export const ISHBOR_SOURCE_COUNTRY = 'UZ'

export function hiringIshBorSourceHandles(): string[] {
  return process.env.HIRING_ISHBOR_CV_SOURCE === 'off'
    ? []
    : [`web:${ISHBOR_SOURCE_KEY}`]
}
