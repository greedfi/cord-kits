export function cleanText(text, max = 400) {
  return String(text ?? '')
    .replace(/@(everyone|here)/gi, '@ $1')
    .replace(/```/g, "'''")
    .trim()
    .slice(0, max)
}
