import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  domainListed,
  inspectLinks,
  inspectWords,
  messageViolation,
} from '../src/filters.js'
import { defaultGuildSettings } from '../src/settings.js'

const words = (match, list, enabled = true) => ({ enabled, match, words: list })
const links = (mode, domains, { enabled = true, allowSubdomains = true } = {}) => ({
  enabled,
  mode,
  domains,
  allowSubdomains,
})

describe('filters', () => {
  test('word match is case-insensitive and does not hit the middle of a word', () => {
    assert.equal(inspectWords('what an Ass that was', words('word', ['ass'])).word, 'ass')
    assert.equal(inspectWords('classic class', words('word', ['ass'])), null)
    assert.equal(inspectWords('classic class', words('contains', ['ass'])).word, 'ass')
    assert.equal(inspectWords('see BadWord here', words('word', ['badword'])).word, 'badword')
    assert.equal(inspectWords('a bad word here', words('word', ['bad word'])).word, 'bad word')
    assert.equal(inspectWords('hello', words('word', ['.*'])), null)
    assert.equal(inspectWords('hello', words('word', ['ass'], false)), null)
    assert.equal(inspectWords('hello', words('word', ['  '])), null)
  })

  test('blocklist and allowlist honor subdomains and ignore non-links', () => {
    const block = links('blocklist', ['evil.com'])
    assert.equal(inspectLinks('hello there', block), null)
    assert.deepEqual(inspectLinks('see https://evil.com/a.', block), { host: 'evil.com', mode: 'blocklist' })
    assert.deepEqual(inspectLinks('see https://EVIL.com/Path', block), { host: 'evil.com', mode: 'blocklist' })
    assert.deepEqual(inspectLinks('www.evil.com/x', block), { host: 'www.evil.com', mode: 'blocklist' })
    assert.equal(inspectLinks('https://notevil.com', block), null)
    assert.equal(inspectLinks('https://evil.com.attacker.com', block), null)
    assert.equal(domainListed('sub.evil.com', ['evil.com'], false), false)
    assert.deepEqual(
      inspectLinks('https://sub.evil.com', links('blocklist', ['evil.com'], { allowSubdomains: false })),
      null,
    )
    assert.deepEqual(inspectLinks('join discord.gg/abc', block.domains ? links('blocklist', ['discord.gg']) : null), {
      host: 'discord.gg',
      mode: 'blocklist',
    })
    assert.deepEqual(
      inspectLinks('click [here](https://evil.com/phish)', block),
      { host: 'evil.com', mode: 'blocklist' },
    )

    const allow = links('allowlist', ['ok.com'])
    assert.equal(inspectLinks('https://ok.com/docs', allow), null)
    assert.equal(inspectLinks('https://sub.ok.com', allow), null)
    assert.deepEqual(inspectLinks('https://ok.com and https://evil.com', allow), {
      host: 'evil.com',
      mode: 'allowlist',
    })
    assert.deepEqual(
      inspectLinks('https://sub.ok.com', links('allowlist', ['ok.com'], { allowSubdomains: false })),
      { host: 'sub.ok.com', mode: 'allowlist' },
    )
    assert.deepEqual(inspectLinks('https://anywhere.com', links('allowlist', [])), {
      host: 'anywhere.com',
      mode: 'allowlist',
    })
    assert.equal(inspectLinks('https://evil.com', links('blocklist', [])), null)
    assert.equal(inspectLinks('https://evil.com', links('off', ['evil.com'])), null)
    assert.equal(inspectLinks('https://evil.com', links('blocklist', ['evil.com'], { enabled: false })), null)
  })

  test('messageViolation reports the word hit before a link hit', () => {
    const settings = defaultGuildSettings()
    settings.wordFilter = { enabled: true, match: 'word', words: ['spam'] }
    settings.linkFilter = { enabled: true, mode: 'blocklist', domains: ['evil.com'], allowSubdomains: true }
    assert.deepEqual(messageViolation('this is spam https://evil.com', settings), { type: 'word', detail: 'spam' })
    assert.deepEqual(messageViolation('https://evil.com', settings), { type: 'link', detail: 'evil.com' })
    assert.equal(messageViolation('hello', settings), null)
    assert.equal(messageViolation('spam', null), null)
  })
})
