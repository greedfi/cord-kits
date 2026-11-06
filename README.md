# cord-kits

Tested discord.js v14 starter kits for .cord. Each kit lives in its own folder, targets Node.js 22.12 or newer, and ships with unit tests. Node.js 20 is not a supported runtime: the music kit's `@discordjs/voice` dependency declares `>=22.12.0`, and every kit sets `engine-strict=true` so npm does not ignore `EBADENGINE`. The music kit plays SoundCloud, direct audio, internet radio, and attachments. It rejects YouTube and does not depend on ytdl, play-dl, or yt-dlp. The moderator kit filters words and links, runs warn / timeout / kick / ban / purge, writes a mod log, and can put a server into raid mode.

| Kit | Path |
| --- | --- |
| Music | [kits/music](kits/music) |
| Moderator | [kits/moderator](kits/moderator) |

Neither invite asks for Administrator.

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

GitHub Actions runs lint and `node --test` on Node.js 22 for both kits.

```bash
cd kits/music && npm ci && npm run lint && npm test
cd kits/moderator && npm ci && npm run lint && npm test
```

## Hosting

Each kit has a `Dockerfile` based on `node:22-slim`. The build exits if that image is older than Node.js 22.12.0. The music image also installs ffmpeg. `railway.json` sets `restartPolicyType` to `ALWAYS` so the process comes back if it exits. Set the Railway service root to the kit directory (`kits/music` or `kits/moderator`), set the token and client id as variables, and provide `config.json` at `/app/config.json` or via `CONFIG_PATH`.

These kits log in to the Discord Gateway and keep running. They are not deployable to Vercel or other serverless platforms. A host that suspends the process will miss voice, filters, and raid sync. Railway (or any similar container host) bills for the always-on service. This repository does not promise free hosting.

`config.json` is read from disk and reloaded in the process. It is not a remote API. Changing it for a running bot takes access to that host's file (or another change the host operator approves). There is no unauthenticated management port. A new image does not overwrite a customer's `config.json` or `data/` directory.

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
