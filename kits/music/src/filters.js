import { UserError } from './errors.js'
import { assertPublicHttpUrl } from './sources.js'

export const FILTERS = {
  off: { graph: null, tempo: 1 },
  bassboost: { graph: 'bass=g=8:f=110:w=0.6', tempo: 1 },
  nightcore: { graph: 'asetrate=57600,aresample=48000', tempo: 1.2 },
  '8d': { graph: 'apulsator=hz=0.08', tempo: 1 },
}

export function tempoOf(filter) {
  return FILTERS[filter]?.tempo ?? 1
}

export function ffmpegArgs({ url, seekSeconds = 0, filter = 'off' }) {
  const preset = FILTERS[filter]
  if (!preset) throw new UserError('Unknown filter.')
  const parsed = assertPublicHttpUrl(url)
  const seek = Number(seekSeconds)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (Number.isFinite(seek) && seek > 0.05) args.push('-ss', seek.toFixed(3))
  args.push('-i', parsed.toString(), '-vn')
  if (preset.graph) args.push('-af', preset.graph)
  args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1')
  return args
}
