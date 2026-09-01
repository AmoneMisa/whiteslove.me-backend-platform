import { getRequestIP, type H3Event } from 'h3'

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function trustedProxyIpHeadersEnabled(): boolean {
  return TRUE_VALUES.has(String(process.env.TRUST_PROXY_IP_HEADERS || '').trim().toLowerCase())
}

export function requestClientIp(event: H3Event): string {
  const ip = getRequestIP(event, {
    xForwardedFor: trustedProxyIpHeadersEnabled(),
  })
  return ip || 'unknown'
}
