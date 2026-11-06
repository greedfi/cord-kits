# cord-kits

Tested discord.js v14 starter kits for .cord. Each kit lives in its own folder, targets Node.js 22.12 or newer, and ships with unit tests. Node.js 20 is not a supported runtime: the music kit's `@discordjs/voice` dependency declares `>=22.12.0`, and every kit sets `engine-strict=true` so npm does not ignore `EBADENGINE`. The music kit plays SoundCloud, direct audio, internet radio, and attachments. It rejects YouTube and does not depend on ytdl, play-dl, or yt-dlp. The moderator kit filters words and links, runs warn / timeout / kick / ban / purge, writes a mod log, and can put a server into raid mode.

| Kit | Path |
| --- | --- |
| Music | [kits/music](kits/music) |
| Moderator | [kits/moderator](kits/moderator) |
| Giveaways | [kits/giveaways](kits/giveaways) |
| Reaction roles | [kits/reaction-roles](kits/reaction-roles) |
| Feed relay | [kits/feed-relay](kits/feed-relay) |
| Tickets | [kits/tickets](kits/tickets) |
| Welcome | [kits/welcome](kits/welcome) |
| Leveling | [kits/leveling](kits/leveling) |

No kit invite asks for Administrator.

## Music

Intents: `Guilds`, `GuildVoiceStates`. Neither is privileged.

Permissions: View Channel, Send Messages, Connect, Speak.

Permission integer: **3148800**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3148800
```

## Moderator

Intents: `Guilds`, `GuildMessages`, `MessageContent`, `GuildMembers`. Enable **Message Content** and **Server Members** in the Developer Portal. Both are privileged.

Permissions: Kick Members, Ban Members, Manage Channels, View Channel, Send Messages, Manage Messages, Read Message History, Manage Roles, Moderate Members.

Permission integer: **1099780140054**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=1099780140054
```

Manage Channels is there so raid mode can set slowmode. Manage Roles is there so raid mode can assign a join-hold role. That assignment is refused for `@everyone`, managed roles, and elevated roles, and raid mode does not edit channel overwrites. Moderate Members covers timeouts, including the join hold, and only when the member is moderatable.

## Giveaways

Intents: `Guilds`. It is not privileged.

Permissions: View Channel, Send Messages, Embed Links, Read Message History.

Permission integer: **84992**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=84992
```

The process ends giveaways itself. It does not use another bot's scheduler. It has to stay running, and a stopped process draws overdue giveaways once when it starts. See [kits/giveaways](kits/giveaways) for the interval, the single-replica lock, and the data files.

## Reaction roles

Intents: `Guilds`. It is not privileged.

Permissions: View Channel, Send Messages, Read Message History, Manage Roles.

Permission integer: **268504064**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268504064
```

Button and select panels only. This is not an emoji reaction role. The bot refuses admin, moderator, managed, and elevated roles, and it checks the role hierarchy on every click. See [kits/reaction-roles](kits/reaction-roles).

## Feed relay

Intents: `Guilds`. It is not privileged.

Permissions: View Channel, Send Messages, Read Message History.

Permission integer: **68608**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=68608
```

RSS and Atom only, including a YouTube channel's public Atom URL. No X credential and no YouTube API key. Feed URLs and redirects are checked for SSRF, including private, link-local, mapped IPv6, and a second DNS lookup at connect time. The process has to stay running. See [kits/feed-relay](kits/feed-relay).

## Tickets

Intents: `Guilds`. It is not privileged. Message Content is not requested.

Permissions: Manage Channels, View Channel, Send Messages, Manage Messages, Attach Files, Read Message History.

Permission integer: **109584**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=109584
```

This kit opens a private channel, not a thread. @everyone cannot view it. A Discord administrator still can. Transcripts, when enabled, are a staff-role file, not a public channel. See [kits/tickets](kits/tickets).

## Welcome

Intents: `Guilds`, `GuildMembers`. Server Members is privileged.

Permissions: View Channel, Send Messages, Manage Roles.

Permission integer: **268438528**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268438528
```

Join and leave messages, an optional non-privileged role, and a rules button. The button is not identity verification and does not bypass Discord membership screening. See [kits/welcome](kits/welcome).

## Leveling

Intents: `Guilds`, `GuildMessages`. Message Content is not requested. The bot counts messages and does not read their text.

Permissions: View Channel, Send Messages, Manage Roles.

Permission integer: **268438528**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268438528
```

XP is stored per server. Level `n` requires `50 * n * (n + 1)` XP. Role rewards are refused when the role is elevated. See [kits/leveling](kits/leveling).

## Setup

Each kit has its own `package.json`.

```bash
cd kits/music   # or any other kit directory
npm install
cp .env.example .env
cp config.example.json config.json
npm run register
npm start
```

Secrets stay in the environment: `DISCORD_BOT_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID` for guild-scoped command registration. `config.json` is per kit, keyed by guild id where a server has its own settings, and it reloads while the process is running. Invalid JSON or a schema failure keeps the last good config and logs an error. `.gitignore` ignores `.env` and `config.json`.

`npm run register` registers the kit's slash commands globally, or to `GUILD_ID` when that variable is set.

## Tests

GitHub Actions runs lint and `node --test` on Node.js 22 for every kit. These are automated tests with mocked Discord boundaries. They are not live Discord tests.

```bash
cd kits/music && npm ci && npm run lint && npm test
cd kits/moderator && npm ci && npm run lint && npm test
cd kits/giveaways && npm ci && npm run lint && npm test
cd kits/reaction-roles && npm ci && npm run lint && npm test
cd kits/feed-relay && npm ci && npm run lint && npm test
cd kits/tickets && npm ci && npm run lint && npm test
cd kits/welcome && npm ci && npm run lint && npm test
cd kits/leveling && npm ci && npm run lint && npm test
```

## Hosting

Each kit has a `Dockerfile` based on `node:22-slim`. The build exits if that image is older than Node.js 22.12.0. The music image also installs ffmpeg. `railway.json` sets `restartPolicyType` to `ALWAYS` so the process comes back if it exits. Set the Railway service root to that kit's directory. Music and moderator read `config.json` from `/app/config.json` or `CONFIG_PATH`, and they write `data/` (or `DATA_DIR`) next to the process. The other images set `DATA_DIR=/data` and `CONFIG_PATH=/data/config.json`. Mount a volume on that path. Without the volume, giveaways, panels, feed cursors, tickets, welcome records, XP, warnings, and raid snapshots disappear when the container is replaced.

These kits log in to the Discord Gateway and keep running. They are not deployable to Vercel or other serverless platforms. A host that suspends the process misses voice, filters, raid sync, giveaway deadlines, feed polls, welcomes, and XP. Railway (or any similar container host) bills for the always-on service. This repository does not promise free hosting.

`config.json` is read from disk and reloaded in the process. It is not a remote API. Changing it for a running bot takes access to that host's file, or another change the host operator approves. There is no unauthenticated management port. A new image does not overwrite a customer's `config.json` or data files. This repository does not push updates into copies that customers already run.

## Releases

A release is pinned by a git tag plus the sha256 of the GitHub tag archive. This repository does not create the tag. Tag the merge commit when you publish.

1. Tag the commit and push the tag:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

2. Download the tag tarball:

   https://github.com/greedfi/cord-kits/archive/refs/tags/v0.1.0.tar.gz

3. Record the checksum next to the tag:

   ```bash
   curl -fsSL -o cord-kits-v0.1.0.tar.gz https://github.com/greedfi/cord-kits/archive/refs/tags/v0.1.0.tar.gz
   sha256sum cord-kits-v0.1.0.tar.gz
   ```

The `v0.1.0` checksum is written down after that tag exists. Until then, the pin is the tag name together with that archive URL. This tree does not move that tag. Kits added after the tagged commit are not part of `v0.1.0`.

| Tag | Archive | sha256 |
| --- | --- | --- |
| v0.1.0 | https://github.com/greedfi/cord-kits/archive/refs/tags/v0.1.0.tar.gz | recorded when the tag is pushed |
