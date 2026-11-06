// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { SsrfError, addressBlockReason, fetchPublic, inspectUrl, requestPublic } from '../src/ssrf.js'

const BLOCKED = [
  '127.0.0.1',
  '10.1.2.3',
  '192.168.1.20',
  '172.16.0.5',
  '169.254.169.254',
  '100.64.0.1',
  '0.0.0.0',
  '255.255.255.255',
  '224.0.0.1',
  '240.0.0.1',
  '192.0.2.1',
  '198.51.100.1',
  '203.0.113.1',
  '198.18.0.1',
  '192.0.0.1',
  '::1',
  '::',
  'fc00::1',
  'fd12::1',
  'fe80::1',
  'ff02::1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::ffff:169.254.169.254',
  '::ffff:a00:1',
  '64:ff9b::7f00:1',
  '2002:7f00:1::',
  '2001:db8::1',
  '2001:0:0:1::',
]

describe('feed address policy', () => {
  test('blocks private, link-local, mapped, and documentation addresses', () => {
    for (const ip of BLOCKED) {
      assert.ok(addressBlockReason(ip), ip)
    }
    assert.equal(addressBlockReason('1.1.1.1'), null)
    assert.equal(addressBlockReason('8.8.8.8'), null)
    assert.equal(addressBlockReason('2606:4700:4700::1111'), null)
  })

  test('rejects credential, protocol, name, and normalized literal bypasses before any request', async () => {
    const calls = []
    const request = async (url) => {
      calls.push(url.href)
      return { status: 200, headers: {}, body: '' }
    }
    const urls = [
      'http://127.0.0.1/',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://0x7f000001/',
      'http://127.1/',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[64:ff9b::127.0.0.1]/',
      'http://[2002:7f00:1::]/',
      'http://169.254.169.254/latest',
      'http://user:pass@example.com/',
      'file:///etc/passwd',
      'http://localhost/feed',
      'http://foo.localhost/feed',
      'http://printer.local/feed',
      'http://service.internal/feed',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]
    for (const url of urls) {
      await assert.rejects(() => fetchPublic(url, { request, resolve: async () => [{ address: '1.1.1.1', family: 4 }] }), SsrfError, url)
    }
    assert.deepEqual(calls, [])
    assert.equal(inspectUrl('https://example.com./feed.xml').hostname, 'example.com.')
  })

  test('rejects a private DNS answer, a redirect, and a rebinding lookup', async () => {
    let lookedUp = 0
    await assert.rejects(() => fetchPublic('https://example.com/feed', {
      resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }],
      request: async () => { throw new Error('should not request') },
    }), SsrfError)

    const redirected = []
    await assert.rejects(() => fetchPublic('https://example.com/feed', {
      resolve: async () => [{ address: '1.1.1.1', family: 4 }],
      request: async (url) => {
        redirected.push(url.hostname)
        return { status: 302, headers: { location: 'http://127.0.0.1/secret' }, body: '' }
      },
    }), SsrfError)
    assert.deepEqual(redirected, ['example.com'])

    await assert.rejects(() => fetchPublic('https://example.com/feed', {
      resolve: async () => {
        lookedUp += 1
        return lookedUp === 1
          ? [{ address: '1.1.1.1', family: 4 }]
          : [{ address: '127.0.0.1', family: 4 }]
      },
      request: async (url, { lookup }) => {
        await new Promise((resolve, reject) => {
          lookup(url.hostname, { family: 4 }, (error, address) => (error ? reject(error) : resolve(address)))
        })
        return { status: 200, headers: {}, body: '<rss></rss>' }
      },
    }), SsrfError)
    assert.ok(lookedUp >= 2)
    await assert.rejects(() => fetchPublic('https://example.com/feed', {
      resolve: async () => [{ address: '1.1.1.1', family: 4 }],
      request: async () => ({ status: 200, headers: { 'content-encoding': 'gzip' }, body: 'not-xml' }),
    }), /Compressed/)
  })

  test('the real HTTP client caps bytes and timeouts, and production fetch never connects to loopback', async () => {
    let hits = 0
    const server = http.createServer((req, res) => {
      hits += 1
      if (req.url === '/slow') return
      if (req.url === '/redir') {
        res.writeHead(302, { location: `http://127.0.0.1:${server.address().port}/secret` })
        res.end()
        return
      }
      if (req.url === '/zip') {
        res.setHeader('content-encoding', 'gzip')
        res.end('not-xml')
        return
      }
      res.end('x'.repeat(80))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const lookup = (_hostname, options, callback) => {
      const done = typeof options === 'function' ? options : callback
      done(null, '127.0.0.1', 4)
    }
    try {
      await assert.rejects(
        () => requestPublic(new URL(`http://127.0.0.1:${port}/big`), { lookup, timeoutMs: 1000, maxBytes: 20 }),
        /too large/,
      )
      await assert.rejects(
        () => requestPublic(new URL(`http://127.0.0.1:${port}/slow`), { lookup, timeoutMs: 200, maxBytes: 1000 }),
        /timed out/,
      )
      await assert.rejects(
        () => requestPublic(new URL(`http://127.0.0.1:${port}/zip`), { lookup, timeoutMs: 1000, maxBytes: 1000 }),
        /Compressed/,
      )
      const redirect = await requestPublic(new URL(`http://127.0.0.1:${port}/redir`), {
        lookup,
        timeoutMs: 1000,
        maxBytes: 1000,
      })
      assert.equal(redirect.status, 302)
      assert.match(String(redirect.headers.location), /\/secret$/)
      const before = hits
      await assert.rejects(() => fetchPublic(`http://127.0.0.1:${port}/big`, { timeoutMs: 1000 }), SsrfError)
      assert.equal(hits, before)
      let lookups = 0
      await assert.rejects(() => fetchPublic('http://example.com/feed', {
        timeoutMs: 1000,
        resolve: async () => {
          lookups += 1
          return lookups === 1
            ? [{ address: '1.1.1.1', family: 4 }]
            : [{ address: '127.0.0.1', family: 4 }]
        },
      }), (error) => error instanceof SsrfError || /not allowed/i.test(error.message))
      assert.equal(hits, before)
      assert.ok(lookups >= 2)
    } finally {
      server.close()
    }
  })
})
