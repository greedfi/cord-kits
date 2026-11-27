# cord-kits

Tested discord.js v14 starter kits for .cord. Each kit lives in its own folder and ships with unit tests. The music kit requires Node.js 22.12 or newer because `@discordjs/voice` 0.19.2 declares that engine. The moderator kit targets Node.js 20 or newer. CI runs both on Node.js 22. The music kit plays SoundCloud, direct audio, internet radio, and attachments. It rejects YouTube and does not depend on ytdl, play-dl, or yt-dlp. The moderator kit filters words and links, runs warn / timeout / kick / ban / purge, writes a mod log, and can put a server into raid mode.

| Kit | Path |
| --- | --- |
| Music | [kits/music](kits/music) |
| Moderator | [kits/moderator](kits/moderator) |

Neither invite asks for Administrator.

## Music

Intents: `Guilds`, `GuildVoiceStates`. Neither is privileged. The song-request channel is off unless `ENABLE_REQUEST_CHANNEL` is set, which adds `GuildMessages` and the privileged Message Content intent. See [kits/music](kits/music).

Permissions: View Channel, Send Messages, Embed Links, Connect, Speak.

Permission integer: **3165184**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3165184
```

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

Secrets stay in the environment: `DISCORD_BOT_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID`. `config.json` is per kit, keyed by guild id where a server has its own settings, and it reloads while the process is running. Invalid JSON or a schema failure keeps the last good config and logs an error. `.gitignore` ignores `.env` and `config.json`.

The music bot registers its slash commands when it logs in. Leave `GUILD_ID` unset for global commands, which can take up to an hour to appear the first time and then survive a re-invite. Set `GUILD_ID` to register on one server immediately. `npm run register` still registers either kit by hand, globally or to `GUILD_ID`.

## Tests

GitHub Actions runs lint and `node --test` on Node.js 22 for both kits. Node.js 22 satisfies the music kit's engine. The moderator kit does not require it.

```bash
cd kits/music && npm ci && npm run lint && npm test
cd kits/moderator && npm ci && npm run lint && npm test
```

## Hosting

The moderator image uses `node:20-slim`. The music image uses `node:22-slim`, checks that Node is 22.12 or newer, and installs ffmpeg. `railway.json` sets `restartPolicyType` to `ALWAYS` so the process comes back if it exits. Music is a Discord Gateway and voice process. It is not a serverless function, and a host that sleeps when idle drops the voice connection. Railway bills for the always-on service. This repository does not promise free hosting. Set the Railway service root to the kit directory (`kits/music` or `kits/moderator`), set the token and client id as variables, and provide `config.json` at `/app/config.json` or via `CONFIG_PATH`. Music playlists and 24/7 state live under `DATA_DIR` (default `data/`). Mount a volume there.

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
