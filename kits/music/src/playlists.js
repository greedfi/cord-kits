import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { UserError } from './errors.js'
import { MAX_PLAYLIST_TRACKS, MAX_PLAYLISTS, MAX_SHARES } from './limits.js'
import { createJsonStore } from './store.js'
import { safeLabel } from './queue.js'

const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function playlistName(value) {
  const name = String(value ?? '').trim().toLowerCase()
  if (!NAME.test(name)) {
    throw new UserError('Playlist names are 1–32 characters: letters, numbers, _ and -.')
  }
  return name
}

function emptyData() {
  return { version: 1, guilds: {}, shares: {} }
}

function validTrack(track) {
  return track && typeof track.url === 'string' && typeof track.kind === 'string'
}

function validate(data) {
  return Boolean(data && data.version === 1 && data.guilds && data.shares && typeof data.guilds === 'object')
}

function storedTrack(track) {
  if (!validTrack(track)) throw new UserError('That track cannot be saved.')
  return {
    kind: track.kind,
    title: safeLabel(track.title || track.url, 120),
    url: track.url,
    durationMs: Number.isFinite(track.durationMs) ? track.durationMs : null,
    soundcloudId: track.soundcloudId ?? null,
  }
}

function guildMap(data, guildId) {
  if (!data.guilds[guildId]) data.guilds[guildId] = {}
  return data.guilds[guildId]
}

function requireOwned(entry, userId, manage) {
  if (!entry) throw new UserError('No playlist with that name.')
  if (entry.ownerId !== userId && !manage) throw new UserError('Only the playlist owner can change it.')
  if (entry.readOnly) throw new UserError('That playlist is a read-only import.')
}

export function createPlaylists(filePath) {
  const store = createJsonStore(filePath, { fallback: emptyData, validate })

  function guard() {
    if (store.damaged()) {
      throw new UserError('Saved playlists are damaged. Fix playlists.json or its .bak before using them.')
    }
  }

  function mutate(guildId, userId, manage, name, fn) {
    const key = playlistName(name)
    return store.update((data) => {
      const guild = guildMap(data, guildId)
      const entry = guild[key] ?? null
      fn(data, guild, key, entry)
      return data
    })
  }

  return {
    filePath,
    damaged: () => store.damaged(),
    list(guildId) {
      guard()
      const guild = store.get().guilds[guildId] ?? {}
      return Object.entries(guild).map(([name, entry]) => ({
        name,
        ownerId: entry.ownerId,
        readOnly: Boolean(entry.readOnly),
        tracks: entry.tracks?.length ?? 0,
        shareCode: entry.shareCode ?? null,
      }))
    },
    show(guildId, name) {
      guard()
      const key = playlistName(name)
      const entry = store.get().guilds[guildId]?.[key]
      if (!entry) throw new UserError('No playlist with that name.')
      return { name: key, ...entry, tracks: entry.tracks.map((track) => ({ ...track })) }
    },
    async create(guildId, userId, name) {
      guard()
      const key = playlistName(name)
      await store.update((data) => {
        const guild = guildMap(data, guildId)
        if (guild[key]) throw new UserError('A playlist with that name already exists.')
        if (Object.keys(guild).length >= MAX_PLAYLISTS) {
          throw new UserError(`This server already has ${MAX_PLAYLISTS} playlists.`)
        }
        guild[key] = { ownerId: userId, readOnly: false, shareCode: null, tracks: [] }
        return data
      })
      return key
    },
    async addTracks(guildId, userId, manage, name, tracks) {
      guard()
      const added = []
      let rejected = 0
      await mutate(guildId, userId, manage, name, (_data, _guild, _key, entry) => {
        requireOwned(entry, userId, manage)
        for (const track of tracks) {
          if (entry.tracks.length >= MAX_PLAYLIST_TRACKS) {
            rejected += 1
            continue
          }
          entry.tracks.push(storedTrack(track))
          added.push(track)
        }
        if (added.length === 0) throw new UserError(`That playlist is full (${MAX_PLAYLIST_TRACKS}).`)
      })
      return { added: added.length, rejected }
    },
    async remove(guildId, userId, manage, name, index) {
      guard()
      let title = 'Untitled'
      await mutate(guildId, userId, manage, name, (_data, _guild, _key, entry) => {
        requireOwned(entry, userId, manage)
        if (!Number.isInteger(index) || index < 1 || index > entry.tracks.length) {
          throw new UserError('That track number is not in the playlist.')
        }
        title = entry.tracks[index - 1].title
        entry.tracks.splice(index - 1, 1)
      })
      return title
    },
    async delete(guildId, userId, manage, name) {
      guard()
      const key = playlistName(name)
      await store.update((data) => {
        const guild = guildMap(data, guildId)
        const entry = guild[key]
        if (!entry) throw new UserError('No playlist with that name.')
        if (entry.ownerId !== userId && !manage) throw new UserError('Only the playlist owner can change it.')
        if (entry.shareCode && data.shares[entry.shareCode]) delete data.shares[entry.shareCode]
        delete guild[key]
        return data
      })
      return key
    },
    async share(guildId, userId, manage, name) {
      guard()
      const key = playlistName(name)
      let code = null
      await store.update((data) => {
        const guild = guildMap(data, guildId)
        const entry = guild[key]
        requireOwned(entry, userId, manage)
        const ownedShares = Object.values(data.shares).filter((item) => item.originGuildId === guildId).length
        if (!entry.shareCode && ownedShares >= MAX_SHARES) {
          throw new UserError(`This server already has ${MAX_SHARES} share codes.`)
        }
        code = entry.shareCode
        if (!code) {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            const next = randomBytes(9).toString('base64url')
            if (!data.shares[next]) {
              code = next
              break
            }
          }
        }
        if (!code) throw new UserError('Could not create a share code.')
        entry.shareCode = code
        data.shares[code] = {
          originGuildId: guildId,
          name: key,
          tracks: entry.tracks.map((track) => ({ ...track })),
        }
        return data
      })
      return code
    },
    async importCode(guildId, userId, code, name) {
      guard()
      const key = playlistName(name)
      const shareCode = String(code ?? '').trim()
      if (!/^[A-Za-z0-9_-]{8,32}$/.test(shareCode)) throw new UserError('That share code is not valid.')
      await store.update((data) => {
        const share = Object.hasOwn(data.shares, shareCode) ? data.shares[shareCode] : null
        if (!share) throw new UserError('No playlist is shared with that code.')
        const guild = guildMap(data, guildId)
        if (guild[key]) throw new UserError('A playlist with that name already exists.')
        if (Object.keys(guild).length >= MAX_PLAYLISTS) {
          throw new UserError(`This server already has ${MAX_PLAYLISTS} playlists.`)
        }
        guild[key] = {
          ownerId: userId,
          readOnly: true,
          shareCode: null,
          tracks: (share.tracks ?? []).slice(0, MAX_PLAYLIST_TRACKS).map((track) => storedTrack(track)),
        }
        return data
      })
      return key
    },
  }
}

export function playlistPath(dir) {
  return path.join(dir, 'playlists.json')
}
