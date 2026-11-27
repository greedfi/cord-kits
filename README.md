# cord-kits

Tested discord.js v14 starter kits for .cord. Each kit lives in its own folder and ships with unit tests. The moderator kit targets Node.js 20 or newer. The music kit requires Node.js 22.12 or newer because `@discordjs/voice` 0.19 declares that engine (`engine-strict`). The music kit plays SoundCloud, direct audio, internet radio, and attachments. It rejects YouTube and does not depend on ytdl, play-dl, or yt-dlp. The moderator kit filters words and links, runs warn / timeout / kick / ban / purge, writes a mod log, and can put a server into raid mode.

| Kit | Path |
| --- | --- |
| Music | [kits/music](kits/music) |
| Moderator | [kits/moderator](kits/moderator) |

Neither invite asks for Administrator.

## Music

Intents: `Guilds`, `GuildVoiceStates`. Neither is privileged. The song-request channel is off unless `ENABLE_REQUEST_CHANNEL=1`, which also needs the privileged Message Content intent.

Permissions: View Channel, Send Messages, Connect, Speak.

Permission integer: **3148800**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3148800
```

The request-channel invite (adds Manage Messages and Read Message History) is **3222528**. Voice channel status is optional and is not in the base invite. See [kits/music](kits/music).

## Moderator

Intents: `Guilds`, `GuildMessages`, `MessageContent`, `GuildMembers`. Enable **Message Content** and **Server Members** in the Developer Portal. Both are privileged.

Permissions: Kick Members, Ban Members, Manage Channels, View Channel, Send Messages, Manage Messages, Read Message History, Manage Roles, Moderate Members.

Permission integer: **1099780140054**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=1099780140054
```

Manage Channels is there so raid mode can set slowmode. Manage Roles is there so raid mode can assign a join-hold role. Moderate Members covers timeouts, including the join hold.

## Setup

Each kit has its own `package.json`.

```bash
cd kits/music   # or kits/moderator
npm install
cp .env.example .env
cp config.example.json config.json
npm run register
npm start
```

Secrets stay in the environment: `DISCORD_BOT_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID` for guild-scoped command registration. `config.json` is per kit, keyed by guild id where a server has its own settings, and it reloads while the process is running. Invalid JSON or a schema failure keeps the last good config and logs an error. `.gitignore` ignores `.env` and `config.json`.

`npm run register` registers the kit's slash commands globally, or to `GUILD_ID` when that variable is set.

## Tests

GitHub Actions runs lint and `node --test` on Node.js 22 for the music kit and Node.js 20 for the moderator kit. Music uses Node.js 22 because `@discordjs/voice` 0.19 requires 22.12 or newer.

```bash
cd kits/music && npm ci && npm run lint && npm test
cd kits/moderator && npm ci && npm run lint && npm test
```

## Hosting

The moderator image uses `node:20-slim`. The music image uses `node:22-slim` (22.12 or newer) and installs ffmpeg. Music is a gateway and voice process, not a serverless function. `railway.json` sets `restartPolicyType` to `ALWAYS` so the process comes back if it exits. Set the Railway service root to the kit directory (`kits/music` or `kits/moderator`), set the token and client id as variables, and provide `config.json` at `/app/config.json` or via `CONFIG_PATH`. Music also needs a persistent `DATA_DIR` (default `/app/data` in the image) for playlists and 24/7 state.

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

The `v0.1.0` checksum is written down after that tag exists. Until then, the pin is the tag name together with that archive URL.

| Tag | Archive | sha256 |
| --- | --- | --- |
| v0.1.0 | https://github.com/greedfi/cord-kits/archive/refs/tags/v0.1.0.tar.gz | recorded when the tag is pushed |
