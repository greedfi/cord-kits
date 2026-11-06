# Giveaways kit

A discord.js v14 giveaway bot. `/giveaway create`, `/giveaway end`, `/giveaway cancel`, and `/giveaway reroll` manage a giveaway. Join and Leave buttons add and remove entries. Winners are chosen with `crypto.randomInt`. State is a JSON file, so a restart can finish a giveaway that came due while the process was down.

Requires Node.js 22.12 or newer (`engines` and `engine-strict=true`). The invite does not request Administrator.

These tests are automated and use mocked Discord objects. They do not talk to Discord. The manual checklist at the bottom is the live check.

## What ending a giveaway requires

The draw runs inside this process. It does not use an external scheduler, a Discord scheduled event, or another bot's routine.

- The process must stay running. A deadline that passes while it is stopped is drawn on the next boot, once.
- The default check interval is 15 seconds (`schedulerIntervalSeconds`, 5–120). A giveaway can end up to one interval late.
- Run one process against one data directory. A file lease rejects a second process on the same directory while the lease is valid. This is not a distributed lock. Do not run a second replica. Do not put the data directory on network-shared storage. If this process loses the lease, it stops sending and stops editing Discord. Two processes with two different data directories can both post.
- This is a Gateway client. It is not deployable to Vercel or another host that suspends the process. Railway bills the always-on container. Nothing here is free.
- Idle cost is the running container. The timer does not call Discord until a giveaway is due or its message still needs an update.

## Intents

| Intent | Privileged |
| --- | --- |
| Guilds | no |

Message Content and Server Members are not requested. Entrant checks use the interaction member, or a single member lookup at draw time.

## Permissions

| Permission | Why |
| --- | --- |
| View Channel | See the giveaway channel |
| Send Messages | Post and edit the giveaway |
| Embed Links | Reserved so a later embed does not need a new invite. This version posts plain text. |
| Read Message History | Edit the existing giveaway message |

Permission integer: **84992**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=84992
```

`/giveaway` defaults to Manage Guild. The handler checks Manage Guild again, or `guilds.<id>.managerRoleId` if you set one. Seeing the command is not enough. Join and Leave are buttons; they do not require Manage Guild. Bots cannot enter. A second join is refused. Leave removes that user. A full list stops at 10,000 entries.

At draw time the bot loads each entrant. People who left, bots, accounts younger than the giveaway's minimum age, and people missing `required_role` are not eligible. If the member lookup fails for any other reason, the draw does not happen and the giveaway stays open. Cancel sets no winners. Reroll draws from entrants who did not win. The same interaction id returns the same reroll instead of drawing again.

Winners are written to disk before the message is edited. A repeat of that edit shows the same winners. The draw itself is not repeated.

Discord's create-message API accepts `nonce` and `enforce_nonce`. discord.js exposes those as `nonce` and `enforceNonce`. If the same bot user sends the same nonce again within a few minutes, Discord returns the existing message instead of creating another. The window is only those few minutes, uniqueness is per author, and deleting the message does not allow that nonce to be reused inside the window. This kit sends a stable nonce derived from the giveaway id. That is short-window retry dedupe. It is not exactly-once delivery over a longer outage.

Each message also ends with a stable `gw:<id>` marker. A send that has never been attempted is posted even when the channel's latest 500 messages are all newer than the giveaway. Immediately before `send`, the giveaway is saved as `sending`. After a restart, a `sending` giveaway is adopted if the marker is in the last 500 messages. If that history read fails, or 500 messages still do not contain the marker, another copy is not sent. A `sending` record whose scan is complete and empty is posted again with the same nonce. A saved message id is edited, not sent again.

## Setup

```bash
cd kits/giveaways
npm install
cp .env.example .env
cp config.example.json config.json
npm run register
npm start
```

Secrets are `DISCORD_BOT_TOKEN`, `CLIENT_ID`, and optional `GUILD_ID`. The log redacts the token. There is no HTTP management port.

`config.json` is gitignored and reloaded from disk. A bad write keeps the last good file. Editing it is a host change, not a remote API. A new image does not replace a customer's config or data. Per-guild fields override the top-level limits. A server with no entry uses those defaults. Account age and the required role are copied onto the giveaway when it is created.

## Storage and recovery

`DATA_DIR` defaults to `./data` locally. The image sets `DATA_DIR=/data` and `CONFIG_PATH=/data/config.json`. Mount a volume there. The directory is not copied into the image, and the container disk is not durable.

`giveaways.json` is the state. Each successful write copies the previous good file to `giveaways.json.bak` first. If the main file cannot be parsed, the process loads the backup and writes it back. If both are corrupt, the process refuses to start rather than replacing them with an empty file. Copy both files to back up. One backup generation means a corrupt newest file rolls back to the previous good write.

Changing the scheduler interval applies on the next config reload after the process is ready. Deadlines are stored as absolute timestamps.

## Manual acceptance

Automated tests did not do these:

- [ ] Invite with permission integer 84992 and confirm the Discord screen matches.
- [ ] Register commands in a test server and create a one-minute giveaway.
- [ ] Join from two accounts, leave from one, and confirm the entry count.
- [ ] Confirm a second join does not add a second entry.
- [ ] Stop the process before the deadline, start it again, and confirm one winner message.
- [ ] Cancel a giveaway and confirm it names no winner.
- [ ] Reroll and confirm the previous winner is not drawn again when someone else entered.
- [ ] Confirm an account without Manage Guild, and without the manager role, cannot end it.
- [ ] Confirm the bot does not post twice after a normal restart.

## Tests

```bash
cd kits/giveaways && npm ci && npm run lint && npm test
```
