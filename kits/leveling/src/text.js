export function cleanText(text, max = 400) {
  let cleaned = ''
  for (const char of String(text ?? '')) {
    const code = char.charCodeAt(0)
    if (code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)) continue
    cleaned += char
  }
  return cleaned
    .replace(/@(everyone|here)/gi, '@\u200b$1')
    .replace(/```/g, "'''")
    .trim()
    .slice(0, max)
}
