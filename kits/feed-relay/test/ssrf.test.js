// Automated tests with mocked Discord boundaries. These are not live Discord tests.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SsrfError, addressBlockReason, fetchPublic, inspectUrl } from '../src/ssrf.js'

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
  })
})
