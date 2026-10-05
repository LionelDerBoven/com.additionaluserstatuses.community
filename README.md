# Additional User Statuses

**A Homey Pro app with the household-wide presence and sleep Flow cards Homey lacks, plus statuses of your own.**

Install it from the [Homey App Store](https://homey.app/a/com.additionaluserstatuses.community).

Homey's presence and sleep cards ask about one user at a time. This app answers for the whole household — everyone
home, everyone asleep, the first and last to leave, arrive, go to bed or wake up — counting only the users that
should count.

## Usage

Install the app, open its settings page, and tick the users who count towards "everyone". New Homey users are counted
automatically; disabled accounts never are. The page shows what each card would answer right now.

| Cards | What they cover |
|---|---|
| Household triggers and conditions | Everyone at home / out / asleep / awake, everyone at home asleep, exactly one at home awake, the first or last person to arrive, leave, sleep or wake. Each trigger carries a *User* tag. |
| Per-user triggers and conditions | A user goes out, comes home, falls asleep or wakes up; is one named person at home or asleep. They fire only for users that count, unlike Homey's own. |
| Statuses | *Vacation* and *Do not disturb* come with the app; add any other on the **Statuses** tab. Every status gets a trigger for taking it on or losing it, conditions, an action for one person or the whole household, and a device per user. A status can leave its holders out of the "everyone" cards, or clear itself when that person comes home. |
| Flow tags | Counts and names of users at home, away, awake, asleep and on vacation. |

The **Log** tab shows the triggers that fired, status changes and errors.

## Limits

- **Homey Pro only.** The app needs `homey:manager:api` to read the user list; Homey Cloud and Homey Bridge do not
  offer that permission. It reads `GET /api/manager/users/user` and never writes to Homey's users, devices or Flows.
  Setting presence or sleep stays Homey's own job (*Mark as at home* / *Mark as asleep*).
- **Polling, once a second.** The Apps SDK gives an app no presence events, and every realtime channel was tested
  and found silent (firmware 13.4.1). One read is about 4 KB and 8–15 ms, so a second-by-second poll costs roughly
  1 % of one core and keeps the cards within a second of Homey's own. Three failed reads in a row back off to at
  most 30 s.
- **A user whose presence was never set** counts as not at home, and **an empty set** of counted users makes every
  "everyone" card false, so nothing fires in an empty house.

## Development

```bash
npm install
npm test                                 # logic checks, no Homey or network needed
npm run lint
homey app validate --level publish
homey app run --remote                   # live on a Homey Pro
python3 tools/genassets.py               # driver images from each driver's icon.svg
python3 tools/genassets.py --photo SRC   # app images, cropped from a photo
```

- `lib/UserWatcher.js` — the poll, and the edge detection behind every trigger.
- `lib/UserStatus.js`, `lib/StatusRegistry.js`, `lib/StatusStore.js` — who counts, and the statuses.
- `lib/HomeyUsersApi.js` — the one Web API call, over `node:http` with a keep-alive socket; no runtime dependencies.
- `tools/scanflows.js` — run in HomeyScript before and after a release to see which Flows use this app's cards.

This is an unofficial community app, not affiliated with or endorsed by Athom B.V. "Homey" is a trademark of
Athom B.V. All artwork is original.

## Credits

Built by LDB Technology, with [Claude](https://claude.com/claude-code) (Anthropic) as co-author.

## License

[GPL-3.0-or-later](LICENSE)
