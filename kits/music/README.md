# Music kit

A discord.js v14 music bot for one server at a time, with a queue per guild. Sources are SoundCloud, direct audio files, internet radio streams, and uploaded attachments. YouTube links are rejected. This kit does not use ytdl, play-dl, or yt-dlp.

Requires Node.js 20 or newer. `@discordjs/voice` 0.19 is pinned because Discord voice channels require the DAVE protocol. That package's own metadata asks for Node.js 22.12 or newer; the published build loads on Node.js 20 (this repo's CI imports it there), including `@snazzah/davey`.

## Intents

Enable these in the Developer Portal under Bot → Privileged Gateway Intents only if they are privileged. None of these are privileged.

| Intent | Enum |
| --- | --- |
| Guilds | `Guilds` |
| Guild Voice States | `GuildVoiceStates` |

## Permissions

The invite does not request Administrator.

| Permission | Bit |
| --- | --- |
| View Channel | `1 << 10` |
| Send Messages | `1 << 11` |
| Connect | `1 << 20` |
| Speak | `1 << 21` |

Permission integer: **3148800**

Invite URL template:

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3148800
```

Replace `<CLIENT_ID>` with the application id. The bot also needs Connect and Speak on the voice channel it should join. View Channel and Send Messages are for slash-command replies.

`/play`, `/skip`, `/stop`, and `/volume` default to members who have Connect. `/queue` is available to everyone in the server. Change either from Server Settings → Integrations. Commands are disabled in DMs.

## Setup

```bash
cd kits/music
npm install
cp .env.example .env
cp config.example.json config.json
```

`.env`:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | yes | Bot token |
| `CLIENT_ID` | yes for `npm run register` | Application id |
| `GUILD_ID` | no | Register commands to one server (instant). Omit for global commands. |
| `SOUNDCLOUD_CLIENT_ID` | no | Public SoundCloud client id. The bot tries to discover one when this is empty. |

`config.json` is gitignored. Edit `defaultVolume` (0–100) and `maxQueueSize` (waiting tracks, not counting the one playing). `guilds` is keyed by server id and can override either value. The process watches the config directory. A bad write (invalid JSON or a schema failure) keeps the last good config and logs an error.

Install ffmpeg on the host, or run the Docker image (it installs ffmpeg). Opus uses `opusscript`. Encryption uses Node's `aes-256-gcm`, with `libsodium-wrappers` installed as a fallback.

```bash
npm run register
npm start
```

Global commands can take up to an hour to appear. Guild registration is immediate. Use one mode. If you registered to a guild and then go global, delete the guild commands in the Developer Portal so they are not listed twice.

## Commands

| Command | Behavior |
| --- | --- |
| `/play` | `query` and/or `file`. Optional `kind`: auto, soundcloud, direct, radio. |
| `/skip` | Plays the next waiting track, or leaves if the queue is empty. |
| `/queue` | Shows the current track and up to 10 waiting tracks. |
| `/stop` | Clears the queue and leaves the voice channel. |
| `/volume` | Sets 0–100 for the current resource and later tracks. |

Join a normal voice channel before `/play`. Stage channels are not supported. The bot joins your channel, deafens itself, and refuses YouTube, non-http(s) URLs, and private or loopback hosts.

SoundCloud playlists queue up to `maxQueueSize` tracks. Each track's stream is resolved when it starts. Direct files, radio playlist URLs (`.m3u`, `.m3u8`, `.pls`), and paths that look like `/stream`, `/radio`, `/live`, or `/listen` are passed to ffmpeg. Attachments must be audio and at most 25 MB.

## Hosting

`Dockerfile` uses `node:20-slim`, installs ffmpeg, and runs as the `node` user. `railway.json` sets `restartPolicyType` to `ALWAYS`.

Point the Railway service root at `kits/music`. Set `DISCORD_BOT_TOKEN` and `CLIENT_ID` in the service variables. The image reads `/app/config.json` (or `CONFIG_PATH`). Copy `config.example.json` to that path; the file is gitignored, so a git deploy does not include it. Mount it or bake it into a private image. The process exits with a clear error when the file is missing.

`npm start` prints `generateDependencyReport()` so a missing ffmpeg, opus, or DAVE build shows up in the logs.
