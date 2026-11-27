import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
} from 'discord.js'
import { progressBar, formatTime } from './progress.js'
import { safeLabel } from './queue.js'

export const SAFE_MENTIONS = { parse: [] }

export const BUTTON_COMMAND = {
  'ck:back': 'back',
  'ck:pause': 'pause',
  'ck:resume': 'resume',
  'ck:skip': 'skip',
  'ck:stop': 'stop',
  'ck:loop': 'loop',
  'ck:shuffle': 'shuffle',
}

function button(customId, label, style, disabled = false) {
  return new ButtonBuilder()
    .setCustomId(customId)
    .setLabel(String(label).slice(0, 80))
    .setStyle(style)
    .setDisabled(disabled)
}

export function embedCharacterCount(embed) {
  const fields = (embed.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  return (embed.title?.length ?? 0)
    + (embed.description?.length ?? 0)
    + (embed.footer?.text?.length ?? 0)
    + (embed.author?.name?.length ?? 0)
    + fields
}

export function buildPlayerMessage(view) {
  const title = safeLabel(view.current ? view.title : 'Nothing playing', 256)
  const line = view.current
    ? progressBar(view.positionMs ?? 0, view.durationMs ?? null)
    : 'The queue is empty.'
  const who = view.requestedBy ? `Requested by ${safeLabel(view.requestedBy, 80)}` : null
  const description = [
    view.current ? (view.paused ? 'Paused' : 'Playing') : 'Idle',
    line,
    `Volume ${view.volume ?? 0}% · Loop ${view.loop || 'off'} · ${view.shuffle ? 'Shuffle on' : 'Shuffle off'}`,
    `Waiting ${view.waiting ?? 0} · Filter ${view.filter || 'off'}`,
    who,
  ].filter(Boolean).join('\n').slice(0, 4096)
  const embed = new EmbedBuilder().setColor(0x3D7A6A).setTitle(title).setDescription(description)
  if (view.artworkUrl) {
    try {
      embed.setThumbnail(view.artworkUrl)
    } catch {
      // Artwork is optional. A rejected URL still leaves a valid embed.
    }
  }
  const idle = !view.current
  const row1 = new ActionRowBuilder().addComponents(
    button('ck:back', 'Back', ButtonStyle.Secondary, idle),
    button(view.paused ? 'ck:resume' : 'ck:pause', view.paused ? 'Resume' : 'Pause', ButtonStyle.Primary, idle),
    button('ck:skip', 'Skip', ButtonStyle.Secondary, idle),
    button('ck:stop', 'Stop', ButtonStyle.Danger, idle && (view.waiting ?? 0) === 0),
  )
  const row2 = new ActionRowBuilder().addComponents(
    button('ck:loop', `Loop ${view.loop || 'off'}`, ButtonStyle.Secondary, false),
    button(
      'ck:shuffle',
      view.shuffle ? 'Shuffle on' : 'Shuffle',
      view.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary,
      false,
    ),
  )
  return {
    embeds: [embed.toJSON()],
    components: [row1.toJSON(), row2.toJSON()],
    allowedMentions: SAFE_MENTIONS,
  }
}

export function buildSearchMessage(token, tracks) {
  const options = tracks.slice(0, 10).map((track, index) => {
    const option = {
      label: safeLabel(track.title || track.url, 100),
      value: String(index),
    }
    if (Number.isFinite(track.durationMs)) option.description = formatTime(track.durationMs).slice(0, 100)
    return option
  })
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ck:pick:${token}`)
    .setPlaceholder('Choose a track')
    .addOptions(options)
  return {
    content: 'Pick a track.',
    components: [new ActionRowBuilder().addComponents(menu).toJSON()],
    allowedMentions: SAFE_MENTIONS,
  }
}
