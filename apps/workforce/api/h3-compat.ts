type ApiEvent = {
  request: Request
  headers: Headers
}

type Handler = (event: ApiEvent) => unknown | Promise<unknown>

function requestUrl(event: ApiEvent): URL {
  return new URL(event.request.url)
}

Object.assign(globalThis, {
  defineEventHandler: (handler: Handler) => handler,
  getRequestURL: requestUrl,
  getQuery: (event: ApiEvent) => Object.fromEntries(requestUrl(event).searchParams.entries()),
  setResponseHeader: (event: ApiEvent, name: string, value: string) => event.headers.set(name, value),
  getRequestHeader: (event: ApiEvent, name: string) => event.request.headers.get(name) || undefined,
  getCookie: (event: ApiEvent, name: string) => {
    const cookie = event.request.headers.get('cookie') || ''
    for (const part of cookie.split(';')) {
      const [key, ...value] = part.trim().split('=')
      if (key === name) return decodeURIComponent(value.join('='))
    }
    return undefined
  },
})

export type { ApiEvent, Handler }

