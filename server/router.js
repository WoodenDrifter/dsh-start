// 路由表：支持 /api/backups/:name/manifest 这类路径参数，零依赖。
export function createRouter() {
  const routes = []

  function add(method, pattern, handler) {
    const segs = pattern.split('/').filter(Boolean)
    routes.push({ method: method.toUpperCase(), segs, handler, pattern })
  }

  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean)
    for (const r of routes) {
      if (r.method !== method && r.method !== 'ALL') continue
      if (r.segs.length !== parts.length) continue
      const params = {}
      let hit = true
      for (let i = 0; i < r.segs.length; i++) {
        const s = r.segs[i]
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i])
        else if (s !== parts[i]) {
          hit = false
          break
        }
      }
      if (hit) return { handler: r.handler, params, pattern: r.pattern }
    }
    return null
  }

  return {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    del: (p, h) => add('DELETE', p, h),
    match,
    routes,
  }
}
