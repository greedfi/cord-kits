import { createHash } from 'node:crypto'

export const HISTORY_PAGE = 100
export const HISTORY_PAGES = 5

export function entryMarker(feedKey, entryId) {
  const hash = createHash('sha256').update(`${feedKey}\n${entryId}`).digest('hex').slice(0, 16)
  return `\u200bref:${hash}`
}

export function feedNonce(marker) {
  const hash = String(marker ?? '').match(/[0-9a-f]{16}/)?.[0] ?? ''
  return `f${hash}`.slice(0, 25)
}

export function scanFeedPages(pages, { marker, botId }) {
  const list = Array.isArray(pages) ? pages : []
  for (const page of list) {
    if (!Array.isArray(page)) return { found: false, complete: false }
    for (const message of page) {
      if (message?.authorId === botId && String(message.content ?? '').includes(marker) && message.id) {
        return { found: true, messageId: String(message.id), complete: true }
      }
    }
    if (page.length < HISTORY_PAGE) return { found: false, complete: true }
  }
  if (list.length === 0) return { found: false, complete: true }
  return { found: false, complete: false }
}

export function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => safeCode(Number.parseInt(hex, 16), match))
    .replace(/&#(\d{1,7});/g, (match, dec) => safeCode(Number.parseInt(dec, 10), match))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function safeCode(code, original) {
  if (!Number.isInteger(code) || code < 32 || code === 127 || code > 0x10ffff) return original
  return String.fromCodePoint(code)
}

export function stripTags(value) {
  return decodeXml(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function tagValue(block, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')
  const match = block.match(pattern)
  return match ? stripTags(match[1]) : ''
}

function atomLink(block) {
  const links = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)]
  let fallback = ''
  for (const link of links) {
    const attrs = link[1]
    const href = attrs.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
    const value = decodeXml(href?.[1] || href?.[2] || '')
    const rel = attrs.match(/\brel\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
    const relation = (rel?.[1] || rel?.[2] || 'alternate').toLowerCase()
    if (relation === 'alternate' && value) return value
    if (!fallback && value) fallback = value
  }
  return fallback || tagValue(block, 'link')
}

function publicLink(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username || url.password) return ''
    return url.href
  } catch {
    return ''
  }
}

export function parseFeed(xml) {
  const text = String(xml ?? '')
  if (text.length > 1_000_000) throw new Error('Feed is too large.')
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw new Error('Feed entities are not supported.')
  }
  const blocks = [...text.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)].slice(0, 100)
  return blocks.map((match) => {
    const block = match[2]
    const link = publicLink(atomLink(block))
    const id = tagValue(block, 'guid') || tagValue(block, 'id') || link
    const published = Date.parse(tagValue(block, 'published') || tagValue(block, 'updated') || tagValue(block, 'pubDate'))
    return {
      id: id.slice(0, 500),
      title: stripTags(tagValue(block, 'title')).slice(0, 180),
      link,
      published: Number.isNaN(published) ? 0 : published,
    }
  }).filter((entry) => entry.id)
}

export function selectNew(state, entries, limit = 5) {
  const current = state ?? { seeded: false, seen: [] }
  const ids = entries.map((entry) => entry.id).filter(Boolean)
  if (!current.seeded) return { seed: true, post: [], seedIds: ids.slice(-500) }
  const seen = new Set(current.seen ?? [])
  const fresh = entries
    .filter((entry) => entry.id && !seen.has(entry.id))
    .sort((a, b) => a.published - b.published || a.id.localeCompare(b.id))
  return { seed: false, post: fresh.slice(0, limit), seedIds: [] }
}

export function commitSeen(state, { seed = false, seedIds = [], postedIds = [], now, intervalMs }) {
  const previous = state ?? { seeded: false, seen: [], failures: 0 }
  const seen = seed
    ? seedIds.slice(-500)
    : [...(previous.seen ?? []), ...postedIds].slice(-500)
  const posted = new Set(postedIds)
  return {
    seeded: true,
    seen,
    inflight: (previous.inflight ?? []).filter((id) => !seen.includes(id) && !posted.has(id)),
    failures: 0,
    nextAttemptAt: now + intervalMs,
    lastError: null,
    lastSuccessAt: now,
  }
}

export function planFailure(state, now, error, intervalMs) {
  const previous = state ?? { seeded: false, seen: [], failures: 0 }
  const failures = (previous.failures ?? 0) + 1
  const backoff = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(failures - 1, 10))
  return {
    ...previous,
    failures,
    nextAttemptAt: now + Math.max(intervalMs, backoff),
    lastError: String(error?.message ?? error).slice(0, 180),
  }
}
