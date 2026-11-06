# Welcome kit

A discord.js v14 bot that sends a join and leave message and can add a normal member role. The rules button records that someone pressed it. **That is not identity verification, a captcha, or a substitute for Discord membership screening.**

Requires Node.js 22.12 or newer. The invite does not request Administrator. Automated tests mock Discord. They do not prove a live join.

## Intents

| Intent | Privileged |
| --- | --- |
| Guilds | no |
| Server Members | yes |

Turn on **Server Members Intent**. Without it, join and leave events do not arrive. This kit does not enable Message Content.

A member with `pending: true` is still in Discord membership screening. The bot records that and does not welcome them or add a role. It does not call any API to approve or skip screening. A later update welcomes them when the new member is not pending and either the cached member was pending or this process recorded that screening join. A missing cache alone does not welcome someone: there is no historical backfill. A second event, including one after a restart, does not send a second welcome or add the role again. A member who is still pending is refused. Leaving clears the record, so a later rejoin can be welcomed again. Joins that happen while the process is offline are missed and stay missed.

## Permissions

| Permission | Why |
| --- | --- |
| View Channel | See the welcome channel |
| Send Messages | Send welcome and leave text |
| Manage Roles | Add the optional member role or the rules role |

Permission integer: **268438528**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268438528
```

`autoRoleId` and `rulesRoleId` are refused when the role is `@everyone`, managed, above the bot, or elevated (Administrator, Manage Guild, Manage Roles, moderation permissions, Mention Everyone, and the same staff set the reaction-roles kit uses). The welcome message is still sent. `/rules` checks Manage Roles again before posting the button.

The button text and the reply both say this is not an identity check. Placeholders are `{user}`, `{guild}`, and `{memberCount}` only. `@everyone` in the guild name is neutralized. Mentions are limited to the joining user.

## Setup and storage

```bash
cd kits/welcome
npm install
cp .env.example .env
cp config.example.json config.json
npm run register
npm start
```

`welcome.json` remembers who was already welcomed and who was seen in screening. It lives in `DATA_DIR` (the image uses `/data`). Mount a volume on one machine. `welcome.json.bak` is the previous good write. Copy both to back up. A bad `config.json` keeps the last good file. There is no HTTP API. A new image does not replace a customer's files. A file beside that data is a single-process lease. It is not a distributed lock. Run one process. Do not run a second replica. Do not put the data directory on network-shared storage. If this process loses the lease, it stops sending and stops changing roles.

This process must stay connected to the Gateway. It is not deployable to Vercel or another host that suspends the process. It will miss joins while it is down and does not backfill them. Railway bills the running container. Nothing here is guaranteed free.

## Manual acceptance

- [ ] Enable the Server Members intent and invite with integer 268438528.
- [ ] Join a server with membership screening on and confirm no welcome or role until screening is finished.
- [ ] Confirm the rules reply says it is not an identity check.
- [ ] Confirm an Administrator role is not assigned.
- [ ] Leave and rejoin and confirm a second welcome is sent only after the leave.

## Tests

```bash
cd kits/welcome && npm ci && npm run lint && npm test
```
