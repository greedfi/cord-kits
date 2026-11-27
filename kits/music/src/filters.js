export const FILTER_GRAPHS = {
  off: null,
  bassboost: 'bass=g=8:f=110:w=0.6',
  nightcore: 'asetrate=48000*1.25,aresample=48000',
  '8d': 'apulsator=hz=0.08',
}

export const FILTER_RATES = {
  off: 1,
  bassboost: 1,
  nightcore: 1.25,
  '8d': 1,
}

export function filterGraph(id) {
  if (!Object.hasOwn(FILTER_GRAPHS, id)) return null
  return FILTER_GRAPHS[id]
}

export function filterRate(id) {
  return FILTER_RATES[id] ?? 1
}

export function ffmpegArguments(url, { seekSeconds = 0, filter = 'off' } = {}) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new TypeError('ffmpeg input must be a URL string')
  }
  if (typeof seekSeconds !== 'number' || !Number.isFinite(seekSeconds) || seekSeconds < 0) {
    throw new TypeError('seekSeconds must be a non-negative finite number')
  }
  const graph = filterGraph(filter)
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  if (seekSeconds > 0) args.push('-ss', seekSeconds.toFixed(3))
  args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5')
  args.push('-i', url, '-vn')
  if (graph) args.push('-af', graph)
  args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1')
  return args
}
