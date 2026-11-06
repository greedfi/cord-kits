import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

export class SsrfError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SsrfError'
  }
}

const v4 = new BlockList()
const v6 = new BlockList()

function add4(subnet, prefix) {
  v4.addSubnet(subnet, prefix, 'ipv4')
}
function add6(subnet, prefix) {
  v6.addSubnet(subnet, prefix, 'ipv6')
}

add4('0.0.0.0', 8)
add4('10.0.0.0', 8)
add4('100.64.0.0', 10)
add4('127.0.0.0', 8)
add4('169.254.0.0', 16)
add4('172.16.0.0', 12)
add4('192.0.0.0', 24)
add4('192.0.2.0', 24)
add4('192.168.0.0', 16)
add4('198.18.0.0', 15)
add4('198.51.100.0', 24)
add4('203.0.113.0', 24)
add4('224.0.0.0', 4)
add4('240.0.0.0', 4)

add6('::', 128)
add6('::1', 128)
add6('fc00::', 7)
add6('fe80::', 10)
add6('fec0::', 10)
add6('ff00::', 8)
add6('2001:db8::', 32)
add6('64:ff9b::', 96)
add6('2002::', 16)
add6('2001::', 32)
add6('100::', 64)

const BLOCKED_NAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google.com',
])

function unwrapMapped(ip) {
  const dotted = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return { version: 4, address: dotted[1], mapped: true }
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return {
    version: 4,
    mapped: true,
    address: `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
  }
}

export function addressBlockReason(raw) {
  const ip = String(raw ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!ip || ip.includes('%')) return 'zone'
  const mapped = unwrapMapped(ip)
  if (mapped) return v4.check(mapped.address, 'ipv4') ? 'mapped' : null
  const version = isIP(ip)
  if (version === 4) return v4.check(ip, 'ipv4') ? 'private' : null
  if (version === 6) return v6.check(ip, 'ipv6') ? 'private' : null
  return 'unrecognized'
}

function blockedName(hostname) {
  const host = hostname.replace(/\.$/, '').toLowerCase()
  if (!host || BLOCKED_NAMES.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true
  return false
}

function hasControlOrSpace(value) {
  for (const char of value) {
    if (char.charCodeAt(0) <= 32) return true
  }
  return false
}

export function inspectUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000 || hasControlOrSpace(raw)) {
    throw new SsrfError('That URL is not allowed.')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfError('That URL is not allowed.')
  }
  if (url.username || url.password) throw new SsrfError('URLs with credentials are not allowed.')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Only http and https URLs are allowed.')
  }
  const hostname = url.hostname.replace(/\.$/, '').toLowerCase()
  if (blockedName(hostname)) throw new SsrfError('That host is not allowed.')
  const literal = hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal)) {
    if (addressBlockReason(literal)) throw new SsrfError('That address is not allowed.')
  }
  return url
}

async function defaultResolve(hostname) {
  const records = await dns.lookup(hostname.replace(/\.$/, ''), { all: true, verbatim: true })
  return records.map((record) => ({ address: record.address, family: record.family }))
}

export async function assertResolved(hostname, resolve) {
  const literal = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (isIP(literal)) {
    if (addressBlockReason(literal)) throw new SsrfError('That address is not allowed.')
    return [{ address: literal, family: isIP(literal) }]
  }
  if (blockedName(literal)) throw new SsrfError('That host is not allowed.')
  const records = await resolve(literal)
  if (!Array.isArray(records) || records.length === 0) throw new SsrfError('That host did not resolve.')
  for (const record of records) {
    if (!record?.address || addressBlockReason(record.address)) {
      throw new SsrfError('That host is not allowed.')
    }
  }
  return records
}

function lookupFrom(resolve) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    assertResolved(hostname, resolve).then((records) => {
      const family = typeof options === 'object' ? options.family : 0
      const chosen = records.find((record) => !family || record.family === family) ?? records[0]
      if (addressBlockReason(chosen.address)) {
        done(new SsrfError('That address is not allowed.'))
        return
      }
      done(null, chosen.address, chosen.family)
    }).catch((error) => done(error))
  }
}

function defaultRequest(url, { lookup, timeoutMs, maxBytes }) {
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method: 'GET',
      headers: {
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
        'user-agent': 'cord-kits-feed-relay',
      },
      lookup,
      timeout: timeoutMs,
      agent: false,
    }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > maxBytes) {
          res.destroy()
          req.destroy(new SsrfError('Feed is too large.'))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new SsrfError('Feed request timed out.')))
    req.on('error', reject)
    req.end()
  })
}

export async function fetchPublic(raw, {
  resolve = defaultResolve,
  request = defaultRequest,
  maxRedirects = 3,
  maxBytes = 1_000_000,
  timeoutMs = 10_000,
  redirectsLeft = maxRedirects,
  seen = new Set(),
} = {}) {
  const url = inspectUrl(raw)
  const key = url.href
  if (seen.has(key)) throw new SsrfError('Redirect loop.')
  seen.add(key)
  await assertResolved(url.hostname, resolve)
  const lookup = lookupFrom(resolve)
  const response = await request(url, { lookup, timeoutMs, maxBytes })
  const body = String(response.body ?? '')
  if (Buffer.byteLength(body) > maxBytes) throw new SsrfError('Feed is too large.')
  const status = response.status
  if (status >= 300 && status < 400) {
    if (redirectsLeft <= 0) throw new SsrfError('Too many redirects.')
    const location = response.headers?.location
    if (!location || Array.isArray(location)) throw new SsrfError('Redirect is missing a location.')
    const next = new URL(location, url).href
    return fetchPublic(next, {
      resolve,
      request,
      maxRedirects,
      maxBytes,
      timeoutMs,
      redirectsLeft: redirectsLeft - 1,
      seen,
    })
  }
  if (status < 200 || status >= 300) throw new SsrfError(`Feed request failed (${status}).`)
  return body
}
