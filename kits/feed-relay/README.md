# Feed relay kit

A discord.js v14 bot that polls RSS and Atom feeds and posts new entries into an allowlisted channel. A YouTube channel's public Atom upload feed is just another HTTPS URL, for example `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`. This kit does not use the YouTube Data API, an API key, or any X/Twitter credential. It does not fetch each entry's page. Only the feed URL is requested.

Requires Node.js 22.12 or newer (`engines` and `engine-strict=true`). The invite does not request Administrator.

Automated tests mock DNS, HTTP, and Discord. They are not live posts. Use the checklist below on a test server.

## Polling, host, and cost

The process has to stay running. It wakes every 30 seconds and fetches a feed only when that feed's `nextAttemptAt` is due. `pollIntervalSeconds` is at least 120 and defaults to 300 in the example, so a feed is not fetched more often than that after a success. A failure backs off from one minute, doubling until one hour, and the cursor is not moved. The first successful fetch records the current entries and posts nothing, so a new feed does not dump its history. Later polls post at most 5 new entries. The rest stay unseen and go out on later polls. Each post ends with a short hash of the feed and entry. A post that has never been attempted is sent even when the latest 500 messages are newer than the entry. The entry id is saved as in-flight before `send`. Discord create-message accepts `nonce` and `enforce_nonce` (discord.js: `nonce` and `enforceNonce`). The same author reusing that nonce within a few minutes gets the existing message back. The window is only those few minutes, so this is not exactly-once delivery. After an attempt, a failed history read or a full 500-message scan that does not contain the hash does not send another copy. A failed send does not mark the entry seen.

This is a Gateway process plus outbound HTTP. It is not deployable to Vercel or another host that suspends the process. Railway bills the always-on container and the egress. Nothing here is guaranteed free. Run one process against one `DATA_DIR`. The file lease is not a distributed lock. Do not run a second replica. Do not put the data directory on network-shared storage. If this process loses the lease, it stops posting. Two processes with two different data directories can both post.

There is no X access and no inherited credential. The only secret is `DISCORD_BOT_TOKEN`.

## SSRF

Feed URLs and every redirect are checked before a connection:

- `http` and `https` only, no username or password, no `file:` or other schemes
- hostnames `localhost`, `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`, and `metadata.google.com` are refused
- every resolved address must be public. One private address in the set refuses the host
- the connection looks the name up again and refuses a private address at that moment, which is the DNS-rebinding check
- the request connects to the address that just passed the check, with `Host` still set to the feed name
- redirects are followed by the same function, up to 3 hops
- blocked ranges include loopback, private, link-local (including `169.254.169.254`), CGNAT `100.64.0.0/10`, multicast, reserved, IPv4-mapped IPv6, unique-local and link-local IPv6, NAT64 `64:ff9b::/96`, 6to4 `2002::/16`, and Teredo `2001:0000::/32`

The config schema only accepts `https://` feed URLs. The fetcher still rejects a redirect onto a private address. Loopback is not on the allowlist. A local-socket test of the HTTP client checks size, timeout, encoding, and redirect status only. Production `fetchPublic` refuses a private address before that client runs, and the lookup callback refuses one again at connect time. That local test is not a live connection to a public host.

## Intents and permissions

| Intent | Privileged |
| --- | --- |
| Guilds | no |

| Permission | Why |
| --- | --- |
| View Channel | See the destination |
| Send Messages | Post the entry |
| Read Message History | Find a post that was sent before its id was saved |

Permission integer: **68608**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=68608
```

Posts use `allowedMentions: { parse: [] }`, strip `@everyone` and `@here`, and suppress embeds. A feed posts only when its `channelId` is in that server's `destinations` list and the fetched channel belongs to that server.

`/feed status` requires Manage Guild at runtime. It shows the feed id, failure count, and next time. It does not show the URL. Adding or removing a feed is a change to `config.json` on the host. There is no HTTP API. A reload of a bad file keeps the last good config. A new image does not replace a customer's config or `feeds.json`.

## Storage

The image sets `DATA_DIR=/data` and `CONFIG_PATH=/data/config.json`. Mount a volume there. `feeds.json` stores the cursor and the backoff. `feeds.json.bak` is the previous good write. If the main file is corrupt, the process restores the backup. If both are corrupt, it refuses to start. Copy both files to back up. One backup generation rolls a corrupt newest file back to the previous good write.

## Setup

```bash
cd kits/feed-relay
npm install
cp .env.example .env
cp config.example.json config.json
npm run register
npm start
```

## Manual acceptance

- [ ] Invite with integer 3072 and confirm the permission screen.
- [ ] Point a test feed at a channel in `destinations` and confirm the first poll posts nothing.
- [ ] Publish a new entry and confirm it appears once.
- [ ] Restart the process and confirm that entry is not posted again.
- [ ] Put the channel only in another server's config and confirm this server does not post it.
- [ ] Confirm `/feed status` does not print the feed URL and that a member without Manage Guild cannot run it.

## Tests

```bash
cd kits/feed-relay && npm ci && npm run lint && npm test
```
