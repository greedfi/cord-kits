import crypto from 'node:crypto'
import fs from 'node:fs'
import { readJsonFile, writeJsonAtomic } from './store.js'

export const MAX_PLAYLISTS_PER_GUILD = 25
export const MAX_TRACKS_PER_PLAYLIST = 100

export function validPlaylistName(name) {
  const text = String(name ?? '').trim()
  if (text.length < 1 || text.length > 32) return null
  if (/[@<>`*_~|\\]/.test(text)) return null
  return text
}

function newId() {
  return crypto.randomBytes(9).toString('base64url')
}

function storedTrack(track) {
  return {
    kind: track.kind,
    title: track.title,
    url: track.url,
    durationMs: Number.isFinite(track.durationMs) ? track.durationMs : null,
    soundcloudId: track.soundcloudId ?? null,
    artist: track.artist ?? null,
  }
}

export function createPlaylistStore({ file, fsImpl = fs, now = () => Date.now() }) {
  let data = readJsonFile(file, fsImpl) ?? { playlists: [] }
  if (!Array.isArray(data.playlists)) data = { playlists: [] }

  function commit(playlists) {
    const next = { playlists }
    writeJsonAtomic(file, next, fsImpl)
    data = next
  }

  function inGuild(guildId) {
    return data.playlists.filter((playlist) => playlist.guildId === guildId)
  }

  function find(guildId, name) {
    const key = validPlaylistName(name)?.toLowerCase()
    if (!key) return null
    return inGuild(guildId).find((playlist) => playlist.name.toLowerCase() === key) ?? null
  }

  function canEdit(playlist, actorId, manage) {
    if (playlist.imported) return false
    return playlist.ownerId === actorId || manage
  }

  return {
    list(guildId) {
      return inGuild(guildId).map((playlist) => ({ ...playlist, tracks: playlist.tracks.slice() }))
    },
    find(guildId, name) {
      const playlist = find(guildId, name)
      return playlist ? { ...playlist, tracks: playlist.tracks.slice() } : null
    },
    create({ guildId, ownerId, name }) {
      const clean = validPlaylistName(name)
      if (!clean) return { ok: false, error: 'bad_name' }
      if (inGuild(guildId).length >= MAX_PLAYLISTS_PER_GUILD) return { ok: false, error: 'too_many' }
      if (find(guildId, clean)) return { ok: false, error: 'exists' }
      const playlist = {
        id: newId(),
        name: clean,
        guildId,
        ownerId,
        tracks: [],
        shareCode: null,
        imported: false,
        createdAt: now(),
        updatedAt: now(),
      }
      commit([...data.playlists, playlist])
      return { ok: true, playlist }
    },
    addTracks({ guildId, actorId, manage, name, tracks }) {
      const playlist = find(guildId, name)
      if (!playlist) return { ok: false, error: 'missing' }
      if (!canEdit(playlist, actorId, manage)) {
        return { ok: false, error: playlist.imported ? 'readonly' : 'forbidden' }
      }
      const room = MAX_TRACKS_PER_PLAYLIST - playlist.tracks.length
      if (room <= 0) return { ok: false, error: 'full', accepted: [], rejected: tracks.length }
      const accepted = tracks.slice(0, room).map(storedTrack)
      const next = data.playlists.map((item) => (
        item.id === playlist.id
          ? { ...item, tracks: [...item.tracks, ...accepted], updatedAt: now() }
          : item
      ))
      commit(next)
      return { ok: true, accepted, rejected: tracks.length - accepted.length }
    },
    removeTrack({ guildId, actorId, manage, name, index }) {
      const playlist = find(guildId, name)
      if (!playlist) return { ok: false, error: 'missing' }
      if (!canEdit(playlist, actorId, manage)) {
        return { ok: false, error: playlist.imported ? 'readonly' : 'forbidden' }
      }
      if (!Number.isInteger(index) || index < 1 || index > playlist.tracks.length) {
        return { ok: false, error: 'bad_index' }
      }
      const tracks = playlist.tracks.slice()
      tracks.splice(index - 1, 1)
      commit(data.playlists.map((item) => (
        item.id === playlist.id ? { ...item, tracks, updatedAt: now() } : item
      )))
      return { ok: true }
    },
    delete({ guildId, actorId, manage, name }) {
      const playlist = find(guildId, name)
      if (!playlist) return { ok: false, error: 'missing' }
      if (playlist.ownerId !== actorId && !manage) return { ok: false, error: 'forbidden' }
      commit(data.playlists.filter((item) => item.id !== playlist.id))
      return { ok: true }
    },
    share({ guildId, actorId, manage, name }) {
      const playlist = find(guildId, name)
      if (!playlist) return { ok: false, error: 'missing' }
      if (playlist.imported) return { ok: false, error: 'readonly' }
      if (!canEdit(playlist, actorId, manage)) return { ok: false, error: 'forbidden' }
      let shareCode = playlist.shareCode
      if (!shareCode) {
        const taken = new Set(data.playlists.map((item) => item.shareCode).filter(Boolean))
        do {
          shareCode = newId()
        } while (taken.has(shareCode))
        commit(data.playlists.map((item) => (
          item.id === playlist.id ? { ...item, shareCode, updatedAt: now() } : item
        )))
      }
      return { ok: true, shareCode }
    },
    importCode({ guildId, ownerId, code }) {
      const source = data.playlists.find((item) => item.shareCode === code && !item.imported)
      if (!source) return { ok: false, error: 'missing' }
      if (source.guildId === guildId) return { ok: false, error: 'same_guild' }
      if (inGuild(guildId).length >= MAX_PLAYLISTS_PER_GUILD) return { ok: false, error: 'too_many' }
      const base = source.name
      let name = base
      let suffix = 2
      while (find(guildId, name)) {
        const extra = ` ${suffix}`
        name = `${base.slice(0, 32 - extra.length)}${extra}`
        suffix += 1
      }
      const playlist = {
        id: newId(),
        name,
        guildId,
        ownerId,
        tracks: source.tracks.map(storedTrack),
        shareCode: null,
        imported: true,
        createdAt: now(),
        updatedAt: now(),
      }
      commit([...data.playlists, playlist])
      return { ok: true, playlist }
    },
  }
}
