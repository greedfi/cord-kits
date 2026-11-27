export function formatTime(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '?:??'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const clock = `${minutes}:${String(seconds).padStart(2, '0')}`
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  return clock
}

export function positionMs({ originMs = 0, startedAt = null, now = null, paused = false, tempo = 1 }) {
  const origin = Number.isFinite(originMs) ? Math.max(0, originMs) : 0
  const rate = Number.isFinite(tempo) && tempo > 0 ? tempo : 1
  if (paused || startedAt == null || now == null) return origin
  return origin + Math.max(0, now - startedAt) * rate
}

export function clampedPosition(position, durationMs) {
  if (durationMs == null || !Number.isFinite(durationMs)) return Math.max(0, position)
  return Math.min(Math.max(0, position), Math.max(0, durationMs))
}

export function progressBar(position, durationMs, width = 20) {
  const elapsed = formatTime(position)
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return `${elapsed} / live`
  }
  const ratio = Math.min(1, Math.max(0, position / durationMs))
  const filled = Math.round(ratio * width)
  const bar = `${'#'.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}`
  return `${elapsed} [${bar}] ${formatTime(durationMs)}`
}
