# Music kit

A discord.js v14 music bot with a queue per server. Sources are SoundCloud (links and name search), direct audio files, internet radio, and uploaded attachments. YouTube links are rejected. Spotify and Apple Music audio are not played. This kit does not use ytdl, play-dl, or yt-dlp.

Requires Node.js 22.12 or newer. `@discordjs/voice` 0.19 is pinned because Discord voice channels require the DAVE protocol, and that package declares `engines.node` of `>=22.12.0`. This kit uses the same engine and `engine-strict=true`, so npm refuses to install on Node.js 20 instead of warning and continuing. CI and the Docker image use Node.js 22.

This process stays connected to the Discord gateway and to voice. It is not a serverless function. A host that freezes or recycles the process when it is idle (Vercel, Lambda, and similar) will not keep playback up. Run one long-lived container. Railway and similar hosts bill for uptime, CPU, and outbound audio. This repository does not promise free hosting.

## Intents

The base bot uses no privileged intent. Enable privileged intents in the Developer Portal only for the opt-in feature below.

| Intent | Enum | Privileged | When |
| --- | --- | --- | --- |
| Guilds | `Guilds` | no | always |
| Guild Voice States | `GuildVoiceStates` | no | always |
| Message Content | `MessageContent` | yes | only if `ENABLE_REQUEST_CHANNEL=1` |

Leave Message Content off unless you turn on the song-request channel. Without the env flag the client does not request that intent, `/setup` refuses to save a channel, and message text is ignored.

## Permissions

The invite does not request Administrator.

Base permissions, used for slash commands and voice:

| Permission | Bit |
| --- | --- |
| View Channel | `1 << 10` |
| Send Messages | `1 << 11` |
| Connect | `1 << 20` |
| Speak | `1 << 21` |

Permission integer: **3148800**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3148800
```

Replace `<CLIENT_ID>` with the application id. The bot sends embed objects through the API, which does not require Embed Links. It also needs Connect and Speak on the voice channel it joins. Stage channels are not supported.

Slash commands that change playback default to members who can Connect. `/queue`, `/nowplaying`, `/ping`, and viewing `/settings` have no default permission. Configuration commands (`/setup`, `/setdj`, `/setdjonly`, `/texttoggle`, `/voicetoggle`, `/stay`) default to Manage Server. Discord still lets a member with Administrator through those defaults, because Administrator implies every permission. Commands are disabled in DMs.

### Song-request channel (opt-in)

Add Manage Messages and Read Message History so the bot can delete request messages and find its player message again:

| Extra permission | Bit |
| --- | --- |
| Manage Messages | `1 << 13` |
| Read Message History | `1 << 16` |

Permission integer for that invite: **3222528** (the base bits plus those two).

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=3222528
```

Also set `ENABLE_REQUEST_CHANNEL=1` and enable Message Content. Both are required. The integer does not turn the intent on.

### Voice channel status (optional)

Discord documents `PUT /channels/{channel.id}/voice-status` with a `status` string of up to 500 characters (`null` clears it). It requires `SET_VOICE_CHANNEL_STATUS` (`1 << 48`). A bot that is **not** in the channel also needs Manage Channels. This bot sets the status only while it is connected, and clears it before it disconnects, so Manage Channels is not requested.

The bit is **not** in the base invite. Playback works without it. If the bot lacks the permission, or Discord rejects the request, the status line is skipped and the song still plays.

Base plus this bit: **281474979859456**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=281474979859456
```

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
| `DISCORD_BOT_TOKEN` | yes | Bot token. Never commit it. |
| `CLIENT_ID` | yes for `npm run register` | Application id |
| `GUILD_ID` | no | Register commands to one server (instant). Omit for global commands. |
| `SOUNDCLOUD_CLIENT_ID` | no | Public SoundCloud client id. When empty, the bot discovers one and caches it until SoundCloud returns 401 or 403. |
| `ENABLE_REQUEST_CHANNEL` | no | `1`, `true`, or `yes` turns on the request channel and the Message Content intent. |
| `DATA_DIR` | no | Playlists, 24/7 rejoin state, and the process lock. Defaults to `./data`. |
| `CONFIG_PATH` | no | Defaults to `./config.json`. |
| `FFMPEG_PATH` | no | Defaults to `ffmpeg` on `PATH`. |

`config.json` is gitignored. It holds server defaults and is reloaded with Ajv. A bad write keeps the last good config and logs an error. Per-server keys live under `guilds`. `maxQueueSize` is the waiting list (the current track does not count) and cannot exceed **1000**, in the schema and again at runtime.

Install ffmpeg on the host, or use the Docker image. Opus uses `opusscript`. Encryption uses Node's `aes-256-gcm`, with `libsodium-wrappers` as a fallback.

```bash
npm run register
npm start
```

Global commands can take up to an hour to appear. Guild registration is immediate. Use one mode. If you registered to a guild and then go global, delete the guild commands so they are not listed twice.

## Commands

| Command | Behavior |
| --- | --- |
| `/play` | Name, URL, and/or file. A name plays the top SoundCloud match. `kind`: auto, soundcloud, direct, radio. |
| `/playskip` | Replace the current track with this one. |
| `/playtop` | Insert at the front of the waiting list. |
| `/search` | SoundCloud results in a select menu. Only the person who searched can choose. |
| `/pause` `/resume` `/skip` `/back` `/replay` `/stop` | Transport. |
| `/queue` `/nowplaying` | Text queue, or the player embed. |
| `/loop` | `song`, `queue`, or `off`. |
| `/shuffle` | Toggles shuffle. Turning it on mixes the waiting list. |
| `/move` `/remove` `/clear` | Waiting-list edits. Clear keeps the current track. |
| `/seek` `/forward` `/rewind` | Position. Live radio cannot be seeked. Forward past the end skips. |
| `/volume` | Live volume, 0–100. The saved default is `/settings`. |
| `/join` `/leave` | Join, or leave and turn 24/7 off. |
| `/filter` | `off`, `bassboost`, `nightcore`, or `8d`. |
| `/sleep` | Leave after 1–180 minutes and do not auto-rejoin. |
| `/stay` | 24/7 mode. Manage Server. |
| `/ping` | Gateway latency. |
| `/settings` | Show defaults. Manage Server can set volume, queue size, autoplay, and filter. |
| `/setup` | Request channel, auto-delete, and commands-only. Manage Server. |
| `/setdj` `/setdjonly` | DJ role and which commands require it. Manage Server. |
| `/texttoggle` `/voicetoggle` | Allow-lists. Manage Server. |
| `/playlist` | `create`, `add`, `addtrack`, `addqueue`, `show`, `play`, `remove`, `delete`, `share`, `import`. |

Join a normal voice channel before playing. The bot deafens itself. It refuses YouTube, Spotify, Apple Music, non-http(s) URLs, URLs with embedded passwords, and private or loopback hosts.

## Player

One message per server carries the embed and the buttons: Back, Pause or Resume, Skip, Stop, Loop, Shuffle. The progress line updates every 15 seconds, and a button or command resets that wait, so edits stay under Discord's channel rate limit. Radio and other tracks without a known length show elapsed time and `live` instead of a bar.

Buttons use the same DJ and channel checks as the matching slash commands. A denial is an ephemeral reply and does not change the queue.

## Song-request channel

`/setup` stores the channel. Members type a track name or a URL. The bot plays the top SoundCloud match, or the URL, and keeps a single player message in that channel. `autodelete` removes the member's message (needs Manage Messages). `commandsonly` rejects music commands outside that channel. Configuration commands still run elsewhere so the server is not locked out of `/setup` and `/texttoggle`.

With the env flag off, none of this runs.

## DJ and channel locks

`/setdj` stores a role. If you have not chosen commands yet, control commands start as DJ-only and `/play` stays open so members can still request songs. `/setdjonly add` and `remove` change that list. Manage Server bypasses the DJ check, including on buttons.

`/texttoggle` and `/voicetoggle` use `enable`, `disable`, `allow`, and `deny`. When the lock is on, a channel that is not on the list is rejected. Manage Server can still change the lock from another channel. An empty allow-list with the lock on allows nobody except that configuration path.

## 24/7, sleep, and voice status

`/stay enabled:true` saves the voice channel under `DATA_DIR` and turns `stayConnected` on for that server. After a disconnect the bot waits 1s, 2s, 4s, and so on, capped at 60s, and stops after 100 attempts. A restart rejoins immediately, then uses the same backoff if the join fails. `/leave`, `/sleep`, and a failed sleep that was due while the process was down set a hold so 24/7 does not undo them. The queue itself is not written to disk. After a restart the bot sits in the channel until the next request.

`/stop` clears the queue and leaves unless 24/7 is on, in which case it stays connected and idle.

Voice status uses the documented endpoint above. It is skipped when the permission is missing.

## Playlists

Playlists live in `DATA_DIR/playlists.json`, not in the image. Writes are atomic (temp file, fsync, rename) and the previous good file is kept as `.bak`. If the main file is corrupt, the next start loads the backup. If both are corrupt, playlist commands refuse to write so they do not erase the files.

A server can keep 25 playlists, each with 100 tracks. The owner, or a member with Manage Server, can change a playlist. `/playlist share` returns a code for a snapshot. Another server imports it with `/playlist import`. The copy is read-only (it can be played or deleted, not edited) and is not a live link. There is no web endpoint and no login for this. Codes are unguessable tokens, not a public URL.

A `process.lock` file holds the pid. A second process using the same `DATA_DIR` exits. A lock whose pid is gone is replaced. This is a single-host lock, not a distributed lock. Do not put `DATA_DIR` on a network share, and do not run two replicas.

## Autoplay, queue size, and filters

Autoplay queues one related SoundCloud track when the queue ends, loop is off, and the track that ended came from SoundCloud. It skips anything already in the queue, the recent history, or the last 50 played ids. If nothing new comes back, or the lookup fails, playback stops. It does not call the lookup again for that ending.

`/filter` is optional DSP through ffmpeg. The graphs are fixed (`bass`, `asetrate`+`aresample`, `apulsator`). User text is never passed to ffmpeg. Nightcore plays at 1.2× and the progress math uses that rate. They need the same ffmpeg binary playback already needs. They are not a studio effect.

## Sources that are not supported

Spotify and Apple Music playlists are not imported. Their track lists are not available from a public API without developer credentials. Spotify's oEmbed endpoint returns a page title, not the tracks. Scraping those sites would break their terms, so this bot does not do it. A Spotify or Apple link is rejected with that reason.

YouTube is rejected, including as a stream URL returned by another host.

## Hosting

`Dockerfile` uses `node:22-slim`, checks that the image is Node.js 22.12.0 or newer, installs ffmpeg, and runs as the `node` user. `railway.json` sets `restartPolicyType` to `ALWAYS` and starts `node src/index.js`, the same command as `npm start` and `npm run register`'s sibling entrypoint.

Point the service root at `kits/music`. Set `DISCORD_BOT_TOKEN` and `CLIENT_ID` as variables. Mount `config.json` at `/app/config.json` or set `CONFIG_PATH`. Mount a volume at `/app/data` or set `DATA_DIR`. Without that volume, playlists and 24/7 state disappear when the container is replaced. The image does not contain `config.json`.

`npm start` prints `generateDependencyReport()` so a missing ffmpeg, opus, or DAVE build shows up in the logs. Logs redact the bot token, `SOUNDCLOUD_CLIENT_ID`, and `client_id=` query values.

Voice connections, ffmpeg processes, progress timers, sleep timers, and rejoin waits are cleared on leave and on SIGINT or SIGTERM.

## Tests

```bash
cd kits/music && npm ci && npm run lint && npm test
```

These tests mock Discord. They do not join a voice channel or call SoundCloud. Nothing in this kit has been live-verified as part of this change.

## Manual live-server checklist

Do not treat this list as done until someone runs it on a real server.

- [ ] Invite with `3148800` and compare the permission screen. Administrator is absent.
- [ ] Register commands and confirm `/play` through `/playlist` appear.
- [ ] Join a voice channel, `/play` a SoundCloud URL, and confirm audio. Pause, resume, skip, back, loop, shuffle, and stop from the buttons.
- [ ] Confirm the progress line does not edit more than once every 15 seconds.
- [ ] `/search` a name, pick a row, and confirm someone else's select is refused.
- [ ] `/seek`, `/forward`, and `/rewind` on a SoundCloud track. Confirm radio refuses seek.
- [ ] Set a DJ role, deny skip for a member without it, and confirm a Manage Server member can still skip. Click the skip button as the member without the role.
- [ ] `/texttoggle` and `/voicetoggle`, then confirm a disallowed channel is refused.
- [ ] Turn on Message Content and `ENABLE_REQUEST_CHANNEL=1`, re-invite with `3222528` if you want auto-delete, `/setup` a channel, type a title, and confirm one player message. Turn the flag off and confirm `/setup` refuses.
- [ ] `/stay enabled:true`, restart the process, and confirm it rejoins. `/sleep 1` and confirm it leaves and does not rejoin.
- [ ] With `SET_VOICE_CHANNEL_STATUS` granted, confirm the voice status shows the title and clears on leave. Without the permission, confirm playback still works.
- [ ] `/playlist create`, add a track, restart, `/playlist show`. `/playlist share`, import the code on another server, and confirm the import cannot be edited.
- [ ] `/filter bassboost`, then `nightcore`, then `8d`, then `off`.
- [ ] Kill the process and confirm ffmpeg is gone. Start a second process on the same `DATA_DIR` and confirm it exits.
