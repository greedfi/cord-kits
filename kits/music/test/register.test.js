import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Events, Routes } from 'discord.js'
import { commandData } from '../src/commands.js'
import { attachCommandSync, syncCommands } from '../src/register.js'

const clientId = '123456789012345678'
const guildId = '111111111111111111'
const otherGuildId = '222222222222222222'
const token = 'super-secret-token'

function memoryRest() {
  const data = new Map()
  const calls = []
  return {
    calls,
    async get(route) {
      calls.push(['get', route])
      return structuredClone(data.get(route) ?? [])
    },
    async put(route, options) {
      calls.push(['put', route])
      data.set(route, structuredClone(options.body))
      return options.body
    },
    seed(route, body) {
      data.set(route, body)
    },
  }
}

function fakeClient(guilds = []) {
  const handlers = { ready: [], guild: [] }
  return {
    user: { id: clientId },
    guilds: { cache: new Map(guilds.map((id) => [id, { id }])) },
    once(event, fn) {
      if (event === Events.ClientReady) handlers.ready.push(fn)
    },
    on(event, fn) {
      if (event === Events.GuildCreate) handlers.guild.push(fn)
    },
    handlers,
  }
}

function puts(rest, route) {
  return rest.calls.filter((call) => call[0] === 'put' && call[1] === route)
}

function omitFalseRequired(command) {
  const copy = structuredClone(command)
  const walk = (option) => {
    if (option.required === false) delete option.required
    option.options?.forEach(walk)
  }
  copy.options?.forEach(walk)
  return copy
}

describe('command registration', () => {
  test('startup registers when commands are missing and skips when they match', async () => {
    const previous = process.env.DISCORD_BOT_TOKEN
    process.env.DISCORD_BOT_TOKEN = token
    try {
      const rest = memoryRest()
      const log = { lines: [], errors: [], log(line) { this.lines.push(line) }, error(line) { this.errors.push(line) } }
      const client = fakeClient()
      const env = { DISCORD_BOT_TOKEN: token, CLIENT_ID: clientId }
      attachCommandSync(client, { rest, env, log })
      const first = await client.handlers.ready[0](client)
      const globalRoute = Routes.applicationCommands(clientId)
      assert.equal(first.updated, true)
      assert.equal(first.scope, 'global')
      assert.equal(puts(rest, globalRoute).length, 1)
      assert.equal(rest.calls.filter((call) => JSON.stringify(call).includes(token)).length, 0)

      const decorated = commandData().map((command, index) => ({
        ...command,
        id: String(index + 1),
        application_id: clientId,
      }))
      rest.seed(globalRoute, decorated)
      const second = await client.handlers.ready[0](client)
      assert.equal(second.updated, false)
      assert.equal(puts(rest, globalRoute).length, 1)
      assert.match(log.lines.at(-1), /already match/)

      rest.get = async () => {
        throw new Error(`401 Unauthorized for ${token}`)
      }
      const failed = await client.handlers.ready[0](client)
      assert.equal(failed, null)
      assert.equal(log.errors.at(-1).includes(token), false)
      assert.match(log.errors.at(-1), /\[redacted\]/)
      assert.match(log.errors.at(-1), /Command registration failed/)
    } finally {
      if (previous === undefined) delete process.env.DISCORD_BOT_TOKEN
      else process.env.DISCORD_BOT_TOKEN = previous
    }
  })

  test('a Discord payload that omits required:false is not registered again', async () => {
    const rest = memoryRest()
    const route = Routes.applicationCommands(clientId)
    rest.seed(route, commandData().map(omitFalseRequired))
    const result = await syncCommands({ rest, clientId, commands: commandData() })
    assert.equal(result.updated, false)
    assert.equal(puts(rest, route).length, 0)
    assert.equal(commandData().some((command) => command.options?.some((option) => option.required === false)), true)
  })

  test('runtime registration uses the logged-in application id', async () => {
    const rest = memoryRest()
    const warnings = []
    const log = {
      log() {},
      warn(line) { warnings.push(line) },
      error(line) { throw new Error(line) },
    }
    const appId = '333333333333333333'
    const client = fakeClient()
    client.application = { id: appId }
    attachCommandSync(client, {
      rest,
      env: { DISCORD_BOT_TOKEN: token, CLIENT_ID: clientId },
      log,
    })
    const result = await client.handlers.ready[0](client)
    assert.equal(result.updated, true)
    assert.equal(puts(rest, Routes.applicationCommands(appId)).length, 1)
    assert.equal(puts(rest, Routes.applicationCommands(clientId)).length, 0)
    assert.match(warnings[0], new RegExp(`${clientId} does not match the logged-in application ${appId}`))
  })

  test('guildCreate in guild mode re-registers that server only', async () => {
    const rest = memoryRest()
    const log = { log() {}, error(line) { throw new Error(line) } }
    const client = fakeClient([guildId])
    const env = { DISCORD_BOT_TOKEN: token, CLIENT_ID: clientId, GUILD_ID: guildId }
    attachCommandSync(client, { rest, env, log })
    const guildRoute = Routes.applicationGuildCommands(clientId, guildId)
    await client.handlers.guild[0]({ id: guildId })
    assert.equal(puts(rest, guildRoute).length, 1)
    await client.handlers.guild[0]({ id: otherGuildId })
    assert.equal(puts(rest, guildRoute).length, 1)
    assert.equal(puts(rest, Routes.applicationGuildCommands(clientId, otherGuildId)).length, 0)
  })

  test('the active scope clears commands on the other scope', async () => {
    const guildRoute = Routes.applicationGuildCommands(clientId, guildId)
    const globalRoute = Routes.applicationCommands(clientId)
    const stale = [{ name: 'old', description: 'Old', type: 1 }]

    const guildMode = memoryRest()
    guildMode.seed(globalRoute, stale)
    const guildResult = await syncCommands({
      rest: guildMode,
      clientId,
      guildId,
      commands: commandData(),
    })
    assert.equal(guildResult.updated, true)
    assert.equal(guildResult.clearedGlobal, true)
    assert.equal(puts(guildMode, globalRoute).length, 1)
    assert.deepEqual(await guildMode.get(globalRoute), [])

    const again = memoryRest()
    again.seed(guildRoute, commandData())
    again.seed(globalRoute, [])
    const skipped = await syncCommands({
      rest: again,
      clientId,
      guildId,
      commands: commandData(),
    })
    assert.equal(skipped.updated, false)
    assert.equal(skipped.clearedGlobal, false)
    assert.equal(again.calls.some((call) => call[0] === 'put'), false)

    const globalMode = memoryRest()
    globalMode.seed(guildRoute, stale)
    const globalResult = await syncCommands({
      rest: globalMode,
      clientId,
      guildIds: [guildId],
      commands: commandData(),
    })
    assert.equal(globalResult.scope, 'global')
    assert.equal(globalResult.updated, true)
    assert.deepEqual(globalResult.clearedGuilds, [guildId])
    assert.deepEqual(await globalMode.get(guildRoute), [])
  })
})
