// Host side of the voice-input plugin: a small proxy between the composer button
// and Doubao streaming ASR (wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async).
// The API key lives in a credential record, never in configuration.
import https from 'node:https'
import zlib from 'node:zlib'
import { randomUUID } from 'node:crypto'

export const inject = ['webServer']

const CREDENTIAL_KEY = 'dsh-voice-input/doubao'
const DEFAULT_RESOURCE_ID = 'volc.seedasr.sauc.duration'
const ASR_HOST = 'openspeech.bytedance.com'
const ASR_PATH = '/api/v3/sauc/bigmodel_async'
const BASE_PATH = '/api/dsh-voice-input'
const MAX_BODY = 32 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 10000
const RESULT_TIMEOUT_MS = 60000
const AUDIO_CHUNK = 3200 // 100 ms of 16 kHz / 16 bit / mono PCM

const TYPE_FULL_REQUEST = 0b0001
const TYPE_AUDIO_ONLY = 0b0010
const TYPE_FULL_RESPONSE = 0b1001
const TYPE_SERVER_ERROR = 0b1111
const FLAG_POS_SEQUENCE = 0b0001
const FLAG_NEG_SEQUENCE = 0b0011
const FLAG_BIT_SEQ = 0b0001
const FLAG_BIT_LAST = 0b0010
const COMPRESS_GZIP = 0b0001
const SERIAL_JSON = 0b0001

// ── credentials ───────────────────────────────────────────────────────────────

async function readSettings(ctx) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || credentials === null) return undefined
  const record = await credentials.readRecord(CREDENTIAL_KEY)
  const payload = record && record.payload
  if (!payload || typeof payload.apiKey !== 'string' || payload.apiKey.length === 0) return undefined
  return {
    apiKey: payload.apiKey,
    resourceId: typeof payload.resourceId === 'string' && payload.resourceId.length > 0
      ? payload.resourceId
      : DEFAULT_RESOURCE_ID,
  }
}

async function writeSettings(ctx, apiKey, resourceId) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined || credentials === null) {
    throw new Error('This profile has no credential store, so the key cannot be saved')
  }
  await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({
    kind: 'grant',
    payload: { apiKey, resourceId },
  }))
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('录音数据太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ── minimal WebSocket client (RFC 6455, client side, masked frames) ────────────

function encodeClientFrame(payload) {
  const length = payload.length
  const mask = Buffer.from([
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ])
  let head
  if (length < 126) {
    head = Buffer.alloc(2)
    head[1] = 0x80 | length
  } else if (length < 65536) {
    head = Buffer.alloc(4)
    head[1] = 0x80 | 126
    head.writeUInt16BE(length, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 0x80 | 127
    head.writeUInt32BE(0, 2)
    head.writeUInt32BE(length, 6)
  }
  head[0] = 0x82 // FIN + binary
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, masked])
}

function connectAsr({ apiKey, resourceId }) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host: ASR_HOST,
      path: ASR_PATH,
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from(randomUUID().replace(/-/g, '')).toString('base64'),
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': randomUUID(),
        'X-Api-Sequence': '-1',
      },
    })

    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      request.destroy()
      reject(new Error('连接火山语音服务超时'))
    }, CONNECT_TIMEOUT_MS)

    request.on('upgrade', (response, socket, head) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve(createConnection(socket, head))
    })

    request.on('response', (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        const detail = Buffer.concat(chunks).toString('utf8').slice(0, 400)
        reject(new Error(`火山语音服务拒绝连接（HTTP ${response.statusCode}）${detail}`))
      })
    })

    request.on('error', (error) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(error)
    })

    request.end()
  })
}

function createConnection(socket, head) {
  let buffered = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0)
  const listeners = { frame: null, close: null, error: null }

  const emit = (name, value) => {
    const listener = listeners[name]
    if (typeof listener === 'function') listener(value)
  }

  const parse = () => {
    while (buffered.length >= 2) {
      const first = buffered[0]
      const second = buffered[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffered.length < 4) return
        length = buffered.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffered.length < 10) return
        length = buffered.readUInt32BE(6) // payloads here never exceed 4 GiB
        offset = 10
      }
      const maskOffset = offset
      if (masked) offset += 4
      if (buffered.length < offset + length) return
      let payload = buffered.subarray(offset, offset + length)
      if (masked) {
        const mask = buffered.subarray(maskOffset, maskOffset + 4)
        const copy = Buffer.alloc(length)
        for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ mask[i & 3]
        payload = copy
      } else {
        payload = Buffer.from(payload)
      }
      buffered = buffered.subarray(offset + length)
      if (opcode === 0x8) {
        emit('close', null)
        try { socket.end() } catch { /* already closed */ }
        return
      }
      if (opcode === 0x9) {
        socket.write(encodePong(payload))
        continue
      }
      if (opcode === 0x2 || opcode === 0x1 || opcode === 0x0) emit('frame', payload)
    }
  }

  const onData = (chunk) => {
    buffered = buffered.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffered, chunk])
    parse()
  }

  socket.on('data', onData)
  socket.on('close', () => emit('close', null))
  socket.on('error', (error) => emit('error', error))
  if (buffered.length > 0) setImmediate(parse)

  return {
    on(name, listener) {
      listeners[name] = listener
      return this
    },
    send(payload) {
      if (socket.destroyed) return
      socket.write(encodeClientFrame(payload))
    },
    close() {
      if (socket.destroyed) return
      try { socket.write(Buffer.from([0x88, 0x82, 1, 2, 3, 4])) } catch { /* best effort */ }
      try { socket.end() } catch { /* already closed */ }
      try { socket.destroy() } catch { /* already destroyed */ }
    },
  }
}

function encodePong(payload) {
  const mask = Buffer.from([7, 11, 13, 17])
  const head = Buffer.alloc(2)
  head[0] = 0x8a
  head[1] = 0x80 | payload.length
  const masked = Buffer.alloc(payload.length)
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i & 3]
  return Buffer.concat([head, mask, masked])
}

// ── Doubao frame encoding ─────────────────────────────────────────────────────

function writeBE32(buffer, offset, value) {
  buffer.writeInt32BE(value, offset)
}

function marshalFrame(type, flags, serial, sequence, payload) {
  const compressed = zlib.gzipSync(payload)
  const head = Buffer.alloc(4)
  head[0] = 0x11 // protocol version 1, header size 4 bytes
  head[1] = (type << 4) | flags
  head[2] = (serial << 4) | COMPRESS_GZIP
  head[3] = 0x00
  const body = Buffer.alloc(8)
  writeBE32(body, 0, sequence)
  body.writeUInt32BE(compressed.length, 4)
  return Buffer.concat([head, body, compressed])
}

function marshalFullRequest(sequence, json) {
  return marshalFrame(TYPE_FULL_REQUEST, FLAG_POS_SEQUENCE, SERIAL_JSON, sequence, Buffer.from(json, 'utf8'))
}

function marshalAudio(sequence, pcma, isLast) {
  return marshalFrame(
    TYPE_AUDIO_ONLY,
    isLast ? FLAG_NEG_SEQUENCE : FLAG_POS_SEQUENCE,
    0,
    sequence,
    pcma,
  )
}

function wavHeader(dataBytes, sampleRate) {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + dataBytes, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // mono
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(dataBytes, 40)
  return head
}

function parseAsrFrame(message) {
  if (message.length < 4) return { kind: 'ignore' }
  const headerSize = message[0] & 0x0f
  const type = message[1] >> 4
  const flags = message[1] & 0x0f
  const compress = message[2] & 0x0f
  let offset = headerSize * 4
  if (type !== TYPE_FULL_RESPONSE && type !== TYPE_SERVER_ERROR) return { kind: 'ignore' }
  if ((flags & FLAG_BIT_SEQ) !== 0 && offset + 4 <= message.length) offset += 4
  let code
  if (type === TYPE_SERVER_ERROR) {
    if (offset + 4 > message.length) return { kind: 'error', error: '火山语音服务返回错误帧' }
    code = message.readInt32BE(offset)
    offset += 4
  }
  if (offset + 4 > message.length) return { kind: 'ignore' }
  const size = message.readUInt32BE(offset)
  offset += 4
  if (offset + size > message.length) return { kind: 'ignore' }
  let payload = message.subarray(offset, offset + size)
  if (compress === COMPRESS_GZIP) {
    try {
      payload = zlib.gunzipSync(payload)
    } catch (error) {
      return { kind: 'ignore' }
    }
  }
  const text = payload.toString('utf8')
  if (type === TYPE_SERVER_ERROR) {
    return { kind: 'error', error: `火山语音服务错误 code=${code} ${text.slice(0, 300)}` }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: 'ignore' }
  }
  const result = parsed && parsed.result
  const recognised = result && typeof result.text === 'string' ? result.text : ''
  return {
    kind: 'result',
    text: recognised,
    final: (flags & FLAG_BIT_LAST) !== 0,
  }
}

// ── recognition ───────────────────────────────────────────────────────────────

async function recognize({ pcm, sampleRate, apiKey, resourceId }) {
  const connection = await connectAsr({ apiKey, resourceId })
  const audio = Buffer.concat([wavHeader(pcm.length, sampleRate), pcm])
  const stats = { frames: 0, results: 0, sentChunks: 0 }

  const finished = new Promise((resolve, reject) => {
    let best = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve(best)
    }, RESULT_TIMEOUT_MS)

    const settle = (fn, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn(value)
    }

    connection
      .on('frame', (message) => {
        stats.frames += 1
        const frame = parseAsrFrame(message)
        if (frame.kind === 'error') {
          settle(reject, new Error(frame.error))
          return
        }
        if (frame.kind !== 'result') return
        stats.results += 1
        if (frame.text) best = frame.text
        if (frame.final) settle(resolve, best)
      })
      .on('error', (error) => settle(reject, error))
      .on('close', () => settle(resolve, best))
  })

  try {
    connection.send(marshalFullRequest(1, JSON.stringify({
      user: { uid: 'dsh-voice-input' },
      audio: { format: 'wav', codec: 'raw', rate: sampleRate, bits: 16, channel: 1 },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: true,
        enable_nonstream: false,
      },
    })))

    let sequence = 2
    for (let offset = 0; offset < audio.length; offset += AUDIO_CHUNK) {
      const isLast = offset + AUDIO_CHUNK >= audio.length
      const piece = audio.subarray(offset, Math.min(offset + AUDIO_CHUNK, audio.length))
      connection.send(marshalAudio(isLast ? -sequence : sequence, piece, isLast))
      sequence += 1
      stats.sentChunks += 1
      if (!isLast) await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const text = await finished
    return { text, stats }
  } finally {
    connection.close()
  }
}

// ── routes ────────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const handleConfig = async (req, res) => {
    try {
      if (req.method === 'GET') {
        const settings = await readSettings(ctx)
        sendJson(res, 200, {
          ok: true,
          configured: settings !== undefined,
          resourceId: settings ? settings.resourceId : DEFAULT_RESOURCE_ID,
        })
        return
      }
      if (req.method === 'POST') {
        const raw = await readBody(req, 64 * 1024)
        const body = JSON.parse(raw.toString('utf8') || '{}')
        const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        const resourceId = typeof body.resourceId === 'string' && body.resourceId.trim().length > 0
          ? body.resourceId.trim()
          : DEFAULT_RESOURCE_ID
        if (apiKey.length === 0) {
          sendJson(res, 400, { ok: false, error: 'API Key 不能为空' })
          return
        }
        await writeSettings(ctx, apiKey, resourceId)
        sendJson(res, 200, { ok: true, configured: true, resourceId })
        return
      }
      sendJson(res, 405, { ok: false, error: '不支持的请求方法' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const handleTranscribe = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: '不支持的请求方法' })
        return
      }
      const settings = await readSettings(ctx)
      if (settings === undefined) {
        sendJson(res, 400, { ok: false, error: '还没填豆包 API Key' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const sampleRate = Number(url.searchParams.get('rate') ?? '16000')
      const pcm = await readBody(req, MAX_BODY)
      if (pcm.length < sampleRate * 2 * 0.2) {
        sendJson(res, 200, { ok: true, text: '' })
        return
      }
      const result = await recognize({
        pcm,
        sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16000,
        apiKey: settings.apiKey,
        resourceId: settings.resourceId,
      })
      sendJson(res, 200, {
        ok: true,
        text: result.text,
        debug: { ...result.stats, keyTail: settings.apiKey.slice(-4), keyLen: settings.apiKey.length },
      })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/config`, handler: handleConfig }),
      ctx.webServer.register({ kind: 'exact', path: `${BASE_PATH}/transcribe`, handler: handleTranscribe }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch { /* registry already gone */ }
      }
    }
  })
}
