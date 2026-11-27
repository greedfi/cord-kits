import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js'
import { filterRate } from './filters.js'
import { playedMs, safeLabel } from './queue.js'

export const SAFE_MENTIONS = { parse: [] }
export const PROGRESS_INTERVAL_MS = 12_000
export const MIN_EDIT_GAP_MS = 4_000

export function formatClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const ss = String(seconds).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`
  return `${minutes}:${ss}`
}

export function progressLine(positionMs, durationMs, width = 16) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 'live'
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs))
  const filled = Math.round(ratio * width)
  const bar = '#'.repeat(filled) + '-'.repeat(width - filled)
  return `[${bar}] ${formatClock(positionMs)} / ${formatClock(durationMs)}`
}

export function editDecision({ now, lastEditAt, reason }) {
  const gap = now - lastEditAt
  if (reason === 'progress') return gap >= PROGRESS_INTERVAL_MS ? 'edit' : 'wait'
  if (gap < MIN_EDIT_GAP_MS) return 'trail'
  return 'edit'
}

function button(customId, label, style, disabled) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(label.slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled)
}

export function playbackPosition(snapshot, now) {
  return playedMs(snapshot, now, filterRate(snapshot.filter))
}

export function nowPlayingPayload(snapshot, now = Date.now()) {
  const current = snapshot.current
  const position = playbackPosition(snapshot, now)
  const title = safeLabel(current?.title || (current ? 'Untitled' : 'Nothing playing'), 256)
  const description = current
    ? progressLine(position, current.durationMs)
    : 'Nothing is playing.'
  const loopLabel = snapshot.loop === 'song' ? 'song' : snapshot.loop === 'queue' ? 'queue' : 'off'
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(snapshot.paused ? 0x99aab5 : 0x1db954)
    .setDescription(description.slice(0, 4096))
    .addFields(
      { name: 'Requested by', value: safeLabel(current?.requestedByTag || '—', 1024), inline: true },
      { name: 'Queue', value: String(snapshot.tracks?.length ?? 0).slice(0, 1024), inline: true },
      { name: 'Loop', value: loopLabel, inline: true },
      { name: 'Volume', value: `${snapshot.volume}%`, inline: true },
      { name: 'Filter', value: snapshot.filter === '8d' ? '8D' : (snapshot.filter || 'off'), inline: true },
    )
  const idle = !current && (snapshot.tracks?.length ?? 0) === 0
  const row = new ActionRowBuilder().addComponents(
    button('np:pause', snapshot.paused ? 'Resume' : 'Pause', ButtonStyle.Primary, !current),
    button('np:skip', 'Skip', ButtonStyle.Secondary, idle),
    button('np:back', 'Back', ButtonStyle.Secondary, (snapshot.history?.length ?? 0) === 0),
    button('np:loop', `Loop ${loopLabel}`, ButtonStyle.Secondary, !current),
    button('np:shuffle', 'Shuffle', ButtonStyle.Secondary, (snapshot.tracks?.length ?? 0) < 2),
  )
  const stopRow = new ActionRowBuilder().addComponents(
    button('np:stop', 'Stop', ButtonStyle.Danger, idle && !snapshot.connected),
  )
  return {
    embeds: [embed],
    components: [row, stopRow],
    allowedMentions: SAFE_MENTIONS,
  }
}

export function searchMenu(results) {
  const options = results.slice(0, 10).map((track, index) => ({
    label: safeLabel(track.title, 100),
    description: safeLabel(track.artist || 'SoundCloud', 100),
    value: String(index),
  }))
  const menu = new StringSelectMenuBuilder()
    .setCustomId('search:pick')
    .setPlaceholder('Choose a track')
    .addOptions(options)
  return {
    components: [new ActionRowBuilder().addComponents(menu)],
    allowedMentions: SAFE_MENTIONS,
  }
}
