function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function inspectWords(content, wordFilter) {
  if (!wordFilter?.enabled) return null
  const text = String(content ?? '')
  for (const raw of wordFilter.words ?? []) {
    const needle = String(raw ?? '').trim()
    if (!needle) continue
    if (wordFilter.match === 'contains') {
      if (text.toLowerCase().includes(needle.toLowerCase())) return { word: needle }
      continue
    }
    const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, 'i')
    if (pattern.test(text)) return { word: needle }
  }
  return null
}

export function extractUrls(content) {
  const found = new Set()
  const patterns = [
    /https?:\/\/[^\s<>()]+/gi,
    /\bwww\.[^\s<>()]+/gi,
    /\bdiscord\.gg\/[^\s<>()]+/gi,
    /\bdiscord(?:app)?\.com\/invite\/[^\s<>()]+/gi,
  ]
  for (const pattern of patterns) {
    for (const match of String(content ?? '').matchAll(pattern)) found.add(match[0])
  }
  return [...found]
}

export function hostOf(raw) {
  let value = String(raw).trim().replace(/[),.!?;:<>\]]+$/g, '')
  if (/^www\./i.test(value)) value = `http://${value}`
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.hostname.replace(/\.$/, '').replace(/^\[|\]$/g, '').toLowerCase()
}

export function domainListed(host, domains, allowSubdomains) {
  const name = String(host ?? '').toLowerCase().replace(/\.$/, '')
  for (const domain of domains ?? []) {
    const candidate = String(domain).trim().toLowerCase().replace(/\.$/, '')
    if (!candidate) continue
    if (name === candidate) return true
    if (allowSubdomains && name.endsWith(`.${candidate}`)) return true
  }
  return false
}

export function inspectLinks(content, linkFilter) {
  if (!linkFilter?.enabled || linkFilter.mode === 'off') return null
  const hosts = extractUrls(content).map(hostOf).filter(Boolean)
  if (hosts.length === 0) return null
  if (linkFilter.mode === 'blocklist') {
    const host = hosts.find((item) => domainListed(item, linkFilter.domains, linkFilter.allowSubdomains))
    return host ? { host, mode: 'blocklist' } : null
  }
  if (linkFilter.mode === 'allowlist') {
    const host = hosts.find((item) => !domainListed(item, linkFilter.domains, linkFilter.allowSubdomains))
    return host ? { host, mode: 'allowlist' } : null
  }
  return null
}

export function messageViolation(content, settings) {
  if (!settings) return null
  const word = inspectWords(content, settings.wordFilter)
  if (word) return { type: 'word', detail: word.word }
  const link = inspectLinks(content, settings.linkFilter)
  if (link) return { type: 'link', detail: link.host }
  return null
}
