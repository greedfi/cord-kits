// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { commitSeen, parseFeed, planFailure, selectNew } from '../src/feed.js'

const rss = `<?xml version="1.0"?>
<rss><channel>
<item>
  <title><![CDATA[Hello @everyone]]></title>
  <link>https://example.com/a</link>
  <guid>a</guid>
  <pubDate>Wed, 01 Jan 2026 00:00:00 GMT</pubDate>
  <description><p>Ignore</p></description>
</item>
<item>
  <title>Second</title>
  <link>javascript:alert(1)</link>
  <guid>b</guid>
  <pubDate>Thu, 02 Jan 2026 00:00:00 GMT</pubDate>
</item>
</channel></rss>`

const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>yt:video:abc123</id>
    <title>Hello &amp; welcome</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
    <published>2026-01-03T00:00:00Z</published>
  </entry>
</feed>`

describe('feed parsing', () => {
  test('reads RSS and Atom, strips markup, and drops unsafe links', () => {
    const items = parseFeed(rss)
    assert.equal(items[0].id, 'a')
    assert.equal(items[0].title, 'Hello @everyone')
    assert.equal(items[0].link, 'https://example.com/a')
    assert.equal(items[1].link, '')
    const video = parseFeed(atom)[0]
    assert.equal(video.id, 'yt:video:abc123')
    assert.equal(video.title, 'Hello & welcome')
    assert.equal(video.link, 'https://www.youtube.com/watch?v=abc123')
    assert.throws(() => parseFeed('<!DOCTYPE foo [<!ENTITY x "y">]><rss></rss>'), /entities/)
  })

  test('seeds once, posts only new ids, and backoff keeps the cursor', () => {
    const entries = [
      { id: 'a', published: 2 },
      { id: 'b', published: 1 },
    ]
    const seeded = selectNew({ seeded: false, seen: [] }, entries)
    assert.equal(seeded.seed, true)
    assert.deepEqual(seeded.post, [])
    const state = commitSeen(null, { seed: true, seedIds: seeded.seedIds, now: 100, intervalMs: 1000 })
    assert.deepEqual(state.seen, ['a', 'b'])
    const again = selectNew(state, entries)
    assert.deepEqual(again.post, [])
    const newer = selectNew(state, [...entries, { id: 'c', published: 3 }, { id: 'd', published: 4 }])
    assert.deepEqual(newer.post.map((entry) => entry.id), ['c', 'd'])
    const limited = selectNew(state, [
      { id: 'c', published: 3 },
      { id: 'd', published: 4 },
      { id: 'e', published: 5 },
    ], 1)
    assert.deepEqual(limited.post.map((entry) => entry.id), ['c'])
    const failed = planFailure(state, 100, new Error('down'), 1000)
    assert.deepEqual(failed.seen, state.seen)
    assert.equal(failed.failures, 1)
    assert.equal(failed.nextAttemptAt, 100 + 60_000)
    const harder = planFailure(failed, 100, 'still down', 1000)
    assert.equal(harder.nextAttemptAt, 100 + 120_000)
    assert.deepEqual(harder.seen, ['a', 'b'])
  })
})
