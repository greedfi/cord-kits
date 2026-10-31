import { isIP } from 'node:net'

export class SourceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SourceError'
    this.code = code
  }
}

const AUDIO_EXTENSIONS = new Set([
  'mp3', 'ogg', 'oga', 'wav', 'wave', 'flac', 'aac', 'm4a', 'opus', 'mpga', 'wma', 'aiff', 'aif',
])
const RADIO_EXTENSIONS = new Set(['pls', 'm3u', 'm3u8', 'asx'])
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'music.youtube.com',
  'youtubeeducation.com',
])
const KINDS = new Set(['auto', 'soundcloud', 'direct', 'radio'])

function bareHost(hostname) {
  return hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

function isPrivateV4(ip) {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateV6(ip) {
  const value = ip.toLowerCase()
  if (value === '::1' || value === '::') return true
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateV4(mapped[1])
  const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16)
    const lo = Number.parseInt(mappedHex[2], 16)
    const v4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`
    return isPrivateV4(v4)
  }
  if (value.startsWith('fc') || value.startsWith('fd')) return true
  if (/^fe[89ab]/.test(value)) return true
  return false
}

export function isBlockedHost(hostname) {
  const host = bareHost(hostname)
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host === 'metadata.google.internal'
    || host.endsWith('.internal')
  ) {
    return true
  }
  const version = isIP(host)
  if (version === 4) return isPrivateV4(host)
  if (version === 6) return isPrivateV6(host)
  if (/^\d+$/.test(host) || host.startsWith('0x')) return true
  return false
}

export function isYouTubeUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return isYouTubeHost(url.hostname)
}

function isYouTubeHost(hostname) {
  const host = bareHost(hostname)
  if (YOUTUBE_HOSTS.has(host)) return true
  if (host.endsWith('.youtube.com')) return true
  if (host.endsWith('.youtube-nocookie.com')) return true
  if (host.endsWith('.youtu.be')) return true
  return false
}

function isSoundCloudHost(hostname) {
  const host = bareHost(hostname)
  return host === 'soundcloud.com' || host.endsWith('.soundcloud.com')
}

function extensionOf(pathname) {
  const base = pathname.split('/').pop() ?? ''
  if (!base.includes('.')) return ''
  return base.slice(base.lastIndexOf('.') + 1).toLowerCase()
}

function looksLikeRadio(url, ext) {
  if (RADIO_EXTENSIONS.has(ext)) return true
  const path = url.pathname.toLowerCase()
  return /\/(stream|radio|live|listen)(\/|$)/.test(path)
    || path.includes('icecast')
    || path.includes('shoutcast')
}

function titleFromUrl(url) {
  const base = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '')
  const stripped = base.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim()
  return stripped || url.hostname
}

export function assertPublicHttpUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new SourceError('invalid_url', 'That does not look like a URL.')
  }
  if (url.username || url.password) {
    throw new SourceError('invalid_url', 'URLs with embedded credentials are not supported.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SourceError('invalid_url', 'Only http and https URLs are supported.')
  }
  if (isYouTubeHost(url.hostname)) {
    throw new SourceError('youtube', 'YouTube is not supported.')
  }
  if (isBlockedHost(url.hostname)) {
    throw new SourceError('blocked_host', 'That host is not allowed.')
  }
  return url
}

function classifyAttachment(attachment, kind) {
  if (!attachment?.url) throw new SourceError('empty', 'Provide a URL or an audio attachment.')
  const url = assertPublicHttpUrl(attachment.url)
  const name = attachment.name ?? ''
  const ext = extensionOf(name) || extensionOf(url.pathname)
  const type = String(attachment.contentType ?? '').toLowerCase().split(';')[0].trim()
  const audio = type.startsWith('audio/') || type === 'application/ogg' || AUDIO_EXTENSIONS.has(ext)
  if (attachment.size > 25 * 1024 * 1024) {
    throw new SourceError('unsupported', 'Attachment is larger than 25 MB.')
  }
  if (kind === 'radio') {
    return { kind: 'radio', url: url.toString(), title: name || url.hostname }
  }
  if (!audio) throw new SourceError('unsupported', 'Attachment is not an audio file.')
  const title = name.replace(/\.[a-z0-9]+$/i, '') || 'Attachment'
  return { kind: 'attachment', url: url.toString(), title }
}

export function classifySource(input, options = {}) {
  const kind = options.kind ?? 'auto'
  if (!KINDS.has(kind)) throw new SourceError('unsupported', 'Unknown source kind.')
  if (options.attachment) return classifyAttachment(options.attachment, kind)
  if (typeof input !== 'string' || input.trim() === '') {
    throw new SourceError('empty', 'Provide a URL or an audio attachment.')
  }
  const url = assertPublicHttpUrl(input.trim())
  const ext = extensionOf(url.pathname)

  if (kind === 'soundcloud') {
    if (!isSoundCloudHost(url.hostname)) {
      throw new SourceError('unsupported', 'That URL is not a SoundCloud link.')
    }
    return { kind: 'soundcloud', url: url.toString(), title: null }
  }
  if (kind === 'direct') {
    return { kind: 'direct', url: url.toString(), title: titleFromUrl(url) }
  }
  if (kind === 'radio') {
    return { kind: 'radio', url: url.toString(), title: url.hostname }
  }
  if (isSoundCloudHost(url.hostname)) {
    return { kind: 'soundcloud', url: url.toString(), title: null }
  }
  if (looksLikeRadio(url, ext)) {
    return { kind: 'radio', url: url.toString(), title: url.hostname }
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return { kind: 'direct', url: url.toString(), title: titleFromUrl(url) }
  }
  throw new SourceError(
    'unsupported',
    'Unsupported source. Use SoundCloud, a direct audio file, a radio stream, or an attachment.',
  )
}
