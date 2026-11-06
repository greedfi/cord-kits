# Tickets kit

A discord.js v14 bot that opens a **private channel** for a ticket. It does not use threads.

Requires Node.js 22.12 or newer (`engines` and `engine-strict=true`). The invite does not request Administrator.

Automated tests mock Discord and check the overwrite list this kit sends. They do not prove that a real Discord channel is hidden. Use the checklist below with a non-staff test account.

## Why a channel, and what that does not mean

A private thread is visible to anyone with Manage Threads on the parent channel, and it archives on its own. This kit creates a normal text channel instead. If a category is set, the channel is created there and then edited with `lockPermissions: false` and the ticket overwrites, so a category allow is not left in place. Changing `staffRoleId` rewrites overwrites on open tickets. A role with only a guild-level View Channel permission is still denied by the `@everyone` deny. That model is what the tests check. A live server can still differ, especially for Administrator.

| Who | View channel |
| --- | --- |
| @everyone | deny |
| opener | allow |
| configured staff role | allow |
| bot | allow |

Discord still lets a member with **Administrator** see every channel. The overwrite does not stop that. The tests record that bypass instead of pretending it does not exist. The bot does not grant Administrator and does not try to hide the channel from administrators.

This is not a thread. The invite does not include Create Private Threads or Send Messages in Threads. Closing deletes the channel after confirmation. It does not archive a thread.

## Transcripts

Transcripts are off unless `transcripts` is true. When they are on, only a member of the configured staff role can confirm the close. The bot fetches up to 100 messages with the HTTP API and writes `DATA_DIR/transcripts/<guild>/<ticket>.txt` with mode `0600`. It does not post the file in a channel. `/ticket transcript` replies ephemerally and checks the staff role again. A server administrator who does not have that role is refused. The opener is refused.

The Message Content privileged intent is **not** enabled. Gateway message events are not read. The HTTP fetch is what currently returns message text for a bot with Read Message History. This is not a complete text transcript: it keeps at most 100 messages, and a message with no content is stored as `[no content]`. Attachment URLs are not copied; the line only notes how many attachments were omitted. If writing the transcript fails, the channel is not deleted.

## Intents and permissions

| Intent | Privileged |
| --- | --- |
| Guilds | no |

| Permission | Why |
| --- | --- |
| Manage Channels | Create the ticket and its overwrites, then delete it |
| View Channel | See the ticket |
| Send Messages | Post in it |
| Read Message History | Fetch the transcript |
| Manage Messages | Staff overwrite includes it so staff can moderate the ticket |
| Attach Files | Opener and staff can attach files |

Permission integer: **109584**

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=109584
```

`/ticket open` and the panel button are available to members. `/ticket panel` and `/ticket transcript` default to Manage Channels, and the handler checks that again for the panel. Transcript access is the staff role, not Manage Channels by itself. Close is the opener or staff, and it asks for a confirm button. A confirm expires after two minutes unless a staff member confirms. One open ticket per person is the default (`oneActive`). A second open is refused. That check is serialized so two clicks do not both pass.

A server with no `staffRoleId` cannot open tickets.

## Setup and storage

```bash
cd kits/tickets
npm install
cp .env.example .env
cp config.example.json config.json
npm run register
npm start
```

The image sets `DATA_DIR=/data` and `CONFIG_PATH=/data/config.json`. Mount a volume there. `tickets.json` is the state, with `tickets.json.bak` as the previous good write. A corrupt main file is restored from the backup. If both are corrupt, the process refuses to start. Copy both files, and the `transcripts/` directory, to back up. Run one process. The file lease is not a distributed lock. Do not run a second replica. Do not put the data directory on network-shared storage. If this process loses the lease, it stops creating, editing, and deleting channels.

`config.json` reloads from disk. A bad write keeps the last good file. Changing it is a host change. There is no HTTP API. A new image does not replace a customer's config or data.

This is a Gateway bot. It is not deployable to Vercel or another host that suspends the process. Railway bills the running container. Nothing here is guaranteed free.

## Manual acceptance

- [ ] Invite with integer 109584.
- [ ] Open a ticket and confirm a member who is not the opener, not staff, and not an administrator cannot see the channel.
- [ ] Confirm a server administrator can still see it.
- [ ] Confirm a second open is refused while the first is open.
- [ ] Close without the confirm button and confirm the channel remains.
- [ ] With transcripts on, confirm the opener cannot finish the close and a staff member can.
- [ ] Confirm `/ticket transcript` shows the file only to the staff role, including an administrator who lacks that role.
- [ ] Restart and confirm the open ticket is still recorded.

## Tests

```bash
cd kits/tickets && npm ci && npm run lint && npm test
```
