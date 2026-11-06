// SSE：任务进度与日志增量的单向推送。断线由 EventSource 自动重连并补发。
const clients = new Set()
const history = []
const MAX_HISTORY = 300
let seq = 0

export function attach(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  const client = { res }
  clients.add(client)

  const lastId = Number(req.headers['last-event-id'] || req.query?.lastEventId || 0)
  if (lastId > 0) {
    for (const e of history) if (e.seq > lastId) writeOne(res, e)
  }

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {}
  }, 15000)

  const close = () => {
    clearInterval(ping)
    clients.delete(client)
  }
  req.on('close', close)
  req.on('error', close)
  res.on('error', close)
  return { close }
}

function writeOne(res, e) {
  try {
    res.write(`id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
  } catch {}
}

export function broadcast(event, data) {
  const e = { seq: ++seq, event, data }
  history.push(e)
  if (history.length > MAX_HISTORY) history.shift()
  for (const c of clients) writeOne(c.res, e)
}

export function count() {
  return clients.size
}
