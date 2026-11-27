# Music kit

A discord.js v14 music bot with a queue per server. `/play` takes a song name or a URL. SoundCloud links, direct audio files, and radio streams are detected automatically. A name plays the top SoundCloud result. Uploaded files use `/playfile`. YouTube links are rejected. Spotify and Apple Music are rejected too. This kit does not use ytdl, play-dl, or yt-dlp.

Requires Node.js 22.12 or newer. `@discordjs/voice` 0.19.2 is pinned because Discord voice needs the DAVE protocol, and that package declares `engines.node` of `>=22.12.0`. This kit sets the same engine and `engine-strict=true`, so npm refuses to install it on Node.js 20 instead of warning and continuing. CI and the Docker image use Node.js 22.

## Intents

The base process does not use a privileged intent.

| Intent | Enum | Privileged |
| --- | --- | --- |
| Guilds | `Guilds` | no |
| Guild Voice States | `GuildVoiceStates` | no |

Set `ENABLE_REQUEST_CHANNEL=true` only if you want the song-request channel. The process then also uses:

| Intent | Enum | Privileged |
| --- | --- | --- |
| Guild Messages | `GuildMessages` | no |
| Message Content | `MessageContent` | yes |

Enable Message Content in the Developer Portal before starting with that flag. Without the flag, `/setup` explains that the feature is off, message content is not requested, and a typed song name does nothing.

## Permissions

The invite does not request Administrator.

| Permission | Bit |
| --- | --- |
| View Channel | `1 << 10` |
| Send Messages | `1 << 11` |
| Embed Links | `1 << 14` |
| Connect | `1 << 20` |
| Speak | `1 << 21` |

Permission integer: **3165184**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3165184
```

Replace `<CLIENT_ID>` with the application id. Playback commands default to members who can Connect. `/queue`, `/nowplaying`, and `/ping` are available to everyone in the server. Settings commands default to Manage Guild. Commands are disabled in DMs. A member who already has Administrator or Manage Guild can change settings and is not blocked by the DJ list. The invite does not ask for Administrator.

Optional permissions, not included in the base invite:

| Extra | Integer with the base permissions | Why |
| --- | --- | --- |
| Manage Messages (`1 << 13`) | **3173376** | Delete typed requests when auto-delete is on |
| Set Voice Channel Status (`1 << 48`) | **281474979875840** | Show the current song on the voice channel |

Both extras together: **281474979884032**.

Voice channel status uses `PUT /channels/{channel.id}/voice-status`. Discord documents `SET_VOICE_CHANNEL_STATUS` for that route. A user who is not in the channel also needs Manage Channels. This bot sets the status only while it is connected, so it checks Set Voice Channel Status and does not ask for Manage Channels. The status is at most 500 characters. If the permission is missing, or Discord rejects the call, playback continues and the channel status is left unchanged. Leaving or stopping clears it when the permission is present.

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
| `CLIENT_ID` | yes for the invite link and `npm run register` | Application id. The running bot registers with its logged-in application id and warns if this value differs. |
| `GUILD_ID` | no | Dev only. Register commands on one server so they update immediately. Leave unset for global commands. |
| `SOUNDCLOUD_CLIENT_ID` | no | Public SoundCloud client id. The bot discovers one when this is empty. |
| `ENABLE_REQUEST_CHANNEL` | no | `true` opts into the request channel and Message Content. |
| `DATA_DIR` | no | Playlists and 24/7 state. Defaults to `./data`. |
| `FFMPEG_PATH` | no | ffmpeg executable. Defaults to `ffmpeg` on `PATH`. |

`config.json` is gitignored. It holds the server defaults and per-guild overrides: volume, queue size, extended queue, autoplay, 24/7, filter, DJ role, channel limits, and the request channel. The process watches the config directory. A bad write keeps the last good config and logs an error. Invalid values never replace a good file.

The waiting queue defaults to 100 tracks. `extendedQueue` raises that to `maxQueueSize`, and the hard cap is 1000. The track that is playing does not count.

Install ffmpeg on the host, or run the Docker image. Opus uses `opusscript`. Encryption uses Node's `aes-256-gcm`, with `libsodium-wrappers` as a fallback.

```bash
npm start
```

The process registers its own slash commands when it logs in, and again when it joins the dev server. A kick and re-invite does not need `npm run register`. That script remains for a manual or CI run and uses the same registration path.

Leave `GUILD_ID` unset for global commands. Global commands can take up to an hour to show up the first time. After that they stay with the application, so a re-invite already has them. Set `GUILD_ID` while developing to register on that server only. Those commands appear immediately, and joining that server again registers them right away. `GUILD_ID` mode clears that application's global commands, so use a separate Discord application for local testing.

Only one scope is kept. Guild mode clears this app's global commands. Global mode clears guild commands on servers the bot is in, including when it joins one. The manual script, run without a logged-in bot, updates the selected scope and clears global commands in guild mode. It does not walk every server.

`npm run register` still works. A registration failure is logged without the bot token, and the process keeps running.

## Commands

| Command | Behavior |
| --- | --- |
| `/play` | One required query: a song name or a URL. SoundCloud, audio files, and radio are detected. A name plays the top SoundCloud result. |
| `/playfile` | Play one required audio attachment. Same queue and permission checks as `/play`. |
| `/playskip` | Play one query now and move the old song to history. |
| `/playtop` | Add one query to the front of the queue. |
| `/search` | SoundCloud results in a select menu. |
| `/pause` `/resume` `/skip` `/back` `/replay` | Player controls. |
| `/stop` `/leave` | Stop and disconnect. |
| `/join` | Join your voice channel. |
| `/queue` `/nowplaying` | Show the queue or the player. |
| `/loop` | `song`, `queue`, or `off`. Skip still moves on. |
| `/shuffle` `/move` `/remove` `/clear` | Edit the waiting queue. |
| `/seek` `/forward` `/rewind` | Seek when the track has a duration. |
| `/volume` | Live volume, 0–100. |
| `/sleep` | Leave after a number of minutes. `0` cancels. |
| `/filter` | `off`, bass boost, nightcore, or 8D. |
| `/settings` | Volume, autoplay, extended queue, and 24/7. |
| `/setup` | Request channel. Requires the feature flag. |
| `/setdj` `/setdjonly` | DJ role and which commands need it. |
| `/texttoggle` `/voicetoggle` | Limit text or voice channels. An empty list means no limit. |
| `/playlist` | create, add, addtrack, addqueue, show, play, remove, delete, share, import. |
| `/ping` | Gateway and round-trip time. |

The player message has Pause/Resume, Skip, Back, Loop, Shuffle, and Stop. The same DJ, text, and voice checks apply to those buttons. The progress line updates every 12 seconds, measured from the start of the edit so a slow edit does not stretch the gap. A control waits at least 4 seconds between edits. Idle panels are not edited. A deleted panel is forgotten.

`/setup` keeps one player message in the request channel. Members type a name or a URL there. Auto-delete removes those messages when the bot has Manage Messages. "Commands only" limits music commands to that channel. Settings commands still work elsewhere so the limit can be changed. The request channel stays usable even if a text allow-list is set.

Join a normal voice channel before playing. The bot needs View Channel, Connect, and Speak there, including on a category overwrite. Stage channels are not supported. The bot joins, deafens itself, and refuses YouTube, Spotify, Apple Music, non-http(s) URLs, and private or loopback hosts. The private-host check is best effort: ffmpeg resolves DNS again and can follow a later redirect.

SoundCloud playlists queue up to the waiting-track cap. Each stream is resolved when it starts. A discovered client id is cached. A 401 or 403 drops that cache and discovers a new id once. `SOUNDCLOUD_CLIENT_ID` is never replaced. Direct files, radio playlist URLs (`.m3u`, `.m3u8`, `.pls`), and paths that look like `/stream`, `/radio`, `/live`, or `/listen` go to ffmpeg. Attachments must be audio and at most 25 MB.

Autoplay appends one related SoundCloud track when the queue ends. It skips the track that just played, anything still queued or in the recent history, and an artist already heard 3 times in that window.

24/7 remembers the voice channel in `DATA_DIR` and rejoins after a restart or an unexpected disconnect. The first retry waits 1 second, then 2, 4, 8, 16, and then 30 seconds. `/leave`, `/stop`, and `/sleep` do not bounce back. A restart during sleep stays disconnected. A missing channel is forgotten instead of retried.

Filters are ffmpeg audio graphs (`bass`, `asetrate`/`aresample`, `apulsator`). They are off until `/filter` is used. The arguments are a fixed list. Nightcore plays at 1.25×, and the progress line uses that rate. A radio stream cannot be seeked.

Saved playlists live in `DATA_DIR/playlists.json`. A server can keep 25, and each can hold 100 tracks. Writes go to a temp file in the same directory, are flushed, and then replace the previous file. The previous good copy is kept as a `.bak`. The owner, or a member with Manage Guild, can change a playlist they created. `/playlist share` returns a code. Another server can `/playlist import` that code as a read-only copy. There is no web endpoint.

Spotify and Apple Music are not playback sources and their playlists are not imported. Both APIs need developer credentials to list tracks. Their public embed endpoints do not return a track list. Scraping those sites would break their terms, so this bot does not do it.

## Hosting

`Dockerfile` uses `node:22-slim`, fails the build if that image is older than Node.js 22.12.0, installs ffmpeg, and runs as the `node` user. `railway.json` starts `node src/index.js` and sets `restartPolicyType` to `ALWAYS`.

This process stays connected to the Discord Gateway and to voice. It is not a serverless function and it is not deployable to Vercel or any host that suspends the process when it is idle. A sleeping host drops playback. Run one long-lived container. Railway charges for that service. This repository does not promise free hosting.

`config.json` is not copied into the image. Put it at `/app/config.json` or set `CONFIG_PATH`. Point `DATA_DIR` at a volume (the image creates an empty `/app/data` owned by `node`). Without the volume, playlists and 24/7 state disappear when the container is replaced. Do not run two processes on the same data directory.

`npm start` prints `generateDependencyReport()` so a missing ffmpeg, opus, or DAVE build shows up in the logs. Tokens and SoundCloud client ids are redacted from log lines. Mentions in titles are stripped before they are sent.

## Tests

These tests mock Discord. They do not join a voice channel or call SoundCloud.

```bash
cd kits/music && npm ci && npm run lint && npm test
```

## Manual live-server checklist

Do not treat this list as done until someone runs it on a Discord server.

- [ ] Invite with `3165184` and compare the permission screen. It does not include Administrator.
- [ ] Confirm ffmpeg and a voice connection on Node.js 22.12 or newer.
- [ ] With `/play`, play a SoundCloud URL, a searched name, a direct URL, and a radio stream. Play an attachment with `/playfile`.
- [ ] Use the player buttons: pause, resume, skip, back, loop, shuffle, stop. Watch the progress line update without a rate-limit failure.
- [ ] Set a DJ role, deny a member, and confirm the same denial on a button.
- [ ] Toggle a text channel and a voice channel.
- [ ] With `ENABLE_REQUEST_CHANNEL` off, confirm `/setup` says the feature is off and typed messages do nothing.
- [ ] With the flag and Message Content on, type a song in the request channel, confirm one player message, auto-delete, and commands-only.
- [ ] Turn on 24/7, restart the process, and confirm it rejoins. Disconnect it and confirm it waits before retrying. Sleep and confirm it stays gone.
- [ ] Try bass boost, nightcore, and 8D where ffmpeg is installed.
- [ ] Grant Set Voice Channel Status and confirm the channel status follows the song. Without that permission, playback still works.
- [ ] Create a playlist, restart, and confirm it is still there. Import a share code from another server and confirm it is read-only.
