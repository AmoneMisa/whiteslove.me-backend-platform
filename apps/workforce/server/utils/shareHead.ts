/**
 * Nuxt may group several head tags in one string. Remove only the social meta
 * elements themselves: filtering the whole string also removes the stylesheet
 * and module-script tags that happen to share that entry.
 */
const SOCIAL_META_RE =
  /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:[^"']+|twitter:[^"']+)["'][^>]*>\s*/giu

export function removeExistingSocialMeta(head: string[]): string[] {
  return head
    .map((entry) => entry.replace(SOCIAL_META_RE, ''))
    .filter((entry) => entry.trim().length > 0)
}
