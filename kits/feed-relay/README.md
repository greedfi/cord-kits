# Feed relay kit

A discord.js v14 bot that polls RSS and Atom feeds and posts new entries into an allowlisted channel. A YouTube channel's public Atom upload feed is just another HTTPS URL, for example `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`. This kit does not use the YouTube Data API, an API key, or any X/Twitter credential. It does not fetch each entry's page. Only the feed URL is requested.

Requires Node.js 22.12 or newer (`engines` and `engine-strict=true`). The invite does not request Administrator.

Automated tests mock DNS, HTTP, and Discord. They are not live posts. Use the checklist below on a test server.

## Polling, host, and cost

The process has to stay running. It wakes every 30 seconds and fetches a feed only when that feed's `nextAttemptAt` is due. `pollIntervalSeconds` is at least 120 and defaults to 300 in the example, so a feed is not fetched more often than that after a success. A failure backs off from one minute, doubling until one hour, and the cursor is not moved. The first successful fetch records the current entries and posts nothing, so a new feed does not dump its history. Later polls post at most 5 new entries. The rest stay unseen and go out on later polls.

This is a Gateway process plus outbound HTTP. It is not deployable to Vercel or another host that suspends the process. Railway bills the always-on container and the egress. Nothing here is guaranteed free. Run one replica against one `DATA_DIR`. Two replicas that do not share that directory can post duplicates.

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

The config schema only accepts `https://` feed URLs. The fetcher still rejects a redirect onto a private address.

## Intents and permissions

| Intent | Privileged |
| --- | --- |
| Guilds | no |

| Permission | Why |
| --- | --- |
| View Channel | See the destination |
| Send Messages | Post the entry |

Permission integer: **3072**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3072
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
