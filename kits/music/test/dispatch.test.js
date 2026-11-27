import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PermissionFlagsBits } from 'discord.js'
import { handleInteraction } from '../src/dispatch.js'
import { SourceError } from '../src/sources.js'
import { createPlaylists } from '../src/playlists.js'
import { tempDir } from './helpers.js'
import {
  GUILD,
  TEXT,
  createInteraction,
  member,
  musicKit,
  options,
  track,
  voiceChannel,
} from './harness.js'
import { createSearchCache } from '../src/search-cache.js'

function ctxFor(kit, extra = {}) {
  return {
    music: kit.music,
    configStore: kit.store,
    playlists: extra.playlists,
    sources: extra.sources ?? { async search() { return [] }, async expand() { return [] } },
    searches: extra.searches ?? createSearchCache(),
    requestChannelEnabled: extra.requestChannelEnabled ?? false,
  }
}

function connected(kit, channel = voiceChannel()) {
  kit.music.snapshot(GUILD)
  return createInteraction({
    member: member({ voice: channel, permissions: [PermissionFlagsBits.Connect] }),
    guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: channel.id } } } },
  })
}

describe('dispatch', () => {
  test('DJ role blocks slash commands and buttons, and Manage Server does not', async () => {
    const kit = musicKit()
    const channel = voiceChannel()
    await kit.music.play(GUILD, channel, [track(), track({ title: 'B', url: 'https://cdn.example.com/b.mp3' })])
    kit.store.config.guilds[GUILD] = {
      djRoleId: '555555555555555555',
      djOnly: ['skip'],
    }
    const ctx = ctxFor(kit)
    const userButton = connected(kit, channel)
    userButton.isButton = () => true
    userButton.customId = 'ck:skip'
    userButton.member = member({ voice: channel })
    await handleInteraction(userButton, ctx)
    assert.match(userButton.calls.at(-1)[1].content, /DJ role/)
    assert.equal(kit.music.snapshot(GUILD).current.title, 'Song')

    const adminButton = connected(kit, channel)
    adminButton.isButton = () => true
    adminButton.customId = 'ck:skip'
    adminButton.member = member({ voice: channel, administrator: true })
    await handleInteraction(adminButton, ctx)
    assert.equal(kit.music.snapshot(GUILD).current.title, 'B')
    kit.music.destroy()
  })

  test('voice lock, command-only channel, and search ownership', async () => {
    const kit = musicKit()
    const channel = voiceChannel()
    const ctx = ctxFor(kit, {
      sources: {
        async search() {
          return [track({ title: 'Pick', url: 'https://soundcloud.com/a/pick', kind: 'soundcloud' })]
        },
      },
    })
    kit.store.config.guilds[GUILD] = { voiceLock: true, voiceChannels: ['999999999999999999'] }
    const blocked = createInteraction({
      commandName: 'play',
      member: member({ voice: channel }),
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
      options: options({ query: 'https://cdn.example.com/song.mp3', kind: 'direct' }),
    })
    await handleInteraction(blocked, ctx)
    assert.match(blocked.calls.at(-1)[1].content, /voice channel is not allowed/)

    kit.store.config.guilds[GUILD] = {
      requestChannelId: TEXT,
      requestCommandsOnly: true,
    }
    const elsewhere = createInteraction({
      commandName: 'skip',
      channelId: '888888888888888888',
      member: member({ voice: channel }),
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: channel.id } } } },
    })
    await handleInteraction(elsewhere, ctx)
    assert.match(elsewhere.calls.at(-1)[1].content, /song request channel/)

    kit.store.config.guilds[GUILD] = {}
    const search = createInteraction({
      commandName: 'search',
      member: member({ id: '10', voice: channel }),
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
      options: options({ query: 'flowers' }),
    })
    await handleInteraction(search, ctx)
    const menu = search.calls.find((call) => call[0] === 'editReply')[1]
    const customId = menu.components[0].components[0].custom_id
    const other = createInteraction({
      customId,
      values: ['0'],
      isStringSelectMenu: () => true,
      isChatInputCommand: () => false,
      member: member({ id: '77', voice: channel }),
      user: { id: '77', username: 'Other', tag: 'Other' },
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
    })
    await handleInteraction(other, ctx)
    assert.match(other.calls.at(-1)[1].content, /someone else/)
    assert.equal(kit.music.snapshot(GUILD).current, null)
    kit.music.destroy()
  })

  test('errors that contain the token are not sent back', async () => {
    const previous = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = 'super-secret-token'
    const kit = musicKit()
    try {
      const channel = voiceChannel()
      const ctx = ctxFor(kit, {
        sources: {
          async search() {
            throw new SourceError('soundcloud', `failed ${process.env.DISCORD_BOT_TOKEN}`)
          },
        },
      })
      const interaction = createInteraction({
        commandName: 'play',
        member: member({ voice: channel }),
        guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
        options: options({ query: 'hello' }),
      })
      await handleInteraction(interaction, ctx)
      const body = JSON.stringify(interaction.calls)
      assert.equal(body.includes('super-secret-token'), false)
    } finally {
      if (previous === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = previous
      kit.music.destroy()
    }
  })

  test('setup stays off without the flag and saves when the flag is on', async () => {
    const kit = musicKit()
    const ctx = ctxFor(kit)
    const interaction = createInteraction({
      commandName: 'setup',
      member: member({ administrator: true }),
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
      options: options({
        channel: { id: TEXT, type: 0 },
        autodelete: true,
        commandsonly: true,
      }),
    })
    await handleInteraction(interaction, ctx)
    assert.match(interaction.calls.at(-1)[1].content, /ENABLE_REQUEST_CHANNEL/)
    assert.equal(kit.store.config.guilds[GUILD], undefined)

    ctx.requestChannelEnabled = true
    const enabled = createInteraction({
      commandName: 'setup',
      member: member({ administrator: true }),
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
      options: options({
        channel: { id: TEXT, type: 0 },
        autodelete: true,
        commandsonly: true,
      }),
    })
    await handleInteraction(enabled, ctx)
    assert.equal(kit.store.config.guilds[GUILD].requestChannelId, TEXT)
    assert.equal(kit.store.config.guilds[GUILD].requestAutoDelete, true)
    assert.equal(kit.store.config.guilds[GUILD].requestCommandsOnly, true)
    kit.music.destroy()
  })

  test('playlist share import is read-only and owned', async () => {
    const dir = tempDir()
    const playlists = createPlaylists(dir.path('playlists.json'))
    const kit = musicKit()
    const channel = voiceChannel()
    const ctx = ctxFor(kit, { playlists })
    const owner = createInteraction({
      commandName: 'playlist',
      member: member({ id: '10', voice: channel }),
      user: { id: '10', username: 'Owner', tag: 'Owner' },
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
      options: options({ name: 'party', query: 'https://cdn.example.com/song.mp3', kind: 'direct' }, 'add'),
    })
    await handleInteraction(createInteraction({
      commandName: 'playlist',
      member: owner.member,
      user: owner.user,
      guild: owner.guild,
      options: options({ name: 'party' }, 'create'),
    }), ctx)
    await handleInteraction(owner, ctx)
    const share = createInteraction({
      commandName: 'playlist',
      member: owner.member,
      user: owner.user,
      guild: owner.guild,
      options: options({ name: 'party' }, 'share'),
    })
    await handleInteraction(share, ctx)
    const code = share.calls.at(-1)[1].content.match(/Share code: ([A-Za-z0-9_-]+)/)[1]
    const stranger = createInteraction({
      commandName: 'playlist',
      member: member({ id: '77' }),
      user: { id: '77', username: 'Stranger', tag: 'Stranger' },
      guild: { id: GUILD, members: { me: { id: 'bot', voice: { channelId: null } } } },
      options: options({ name: 'party', query: 'https://cdn.example.com/other.mp3' }, 'add'),
    })
    await handleInteraction(stranger, ctx)
    assert.match(stranger.calls.at(-1)[1].content, /owner/)
    const imported = createInteraction({
      commandName: 'playlist',
      guildId: '666666666666666666',
      member: member({ id: '77' }),
      user: { id: '77', username: 'Stranger', tag: 'Stranger' },
      guild: { id: '666666666666666666', members: { me: { id: 'bot', voice: { channelId: null } } } },
      options: options({ code, name: 'copy' }, 'import'),
    })
    await handleInteraction(imported, ctx)
    const edit = createInteraction({
      commandName: 'playlist',
      guildId: '666666666666666666',
      member: member({ id: '77' }),
      user: { id: '77', username: 'Stranger', tag: 'Stranger' },
      guild: imported.guild,
      options: options({ name: 'copy', query: 'https://cdn.example.com/nope.mp3' }, 'add'),
    })
    await handleInteraction(edit, ctx)
    assert.match(edit.calls.at(-1)[1].content, /read-only/)
    const shown = playlists.show('666666666666666666', 'copy')
    assert.equal(shown.readOnly, true)
    assert.equal(shown.tracks.length, 1)
    dir.remove()
    kit.music.destroy()
  })
})

describe('search cache', () => {
  test('expires and rejects another guild', () => {
    let now = 0
    const cache = createSearchCache({ now: () => now, ttl: 1000 })
    const token = cache.put(GUILD, '10', [track()])
    assert.equal(cache.take(token, { guildId: '666666666666666666', userId: '10' }).error, 'owner')
    now = 1000
    assert.equal(cache.take(token, { guildId: GUILD, userId: '10' }).error, 'expired')
  })
})
