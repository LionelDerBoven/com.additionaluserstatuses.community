# Extra User Statuses

A Homey Pro app that adds the two household-wide Flow condition cards Homey does
not have:

- **Everyone is at home**
- **Everyone is asleep**

Homey ships presence and sleep cards per user — *"John is at home"*, *"John is
asleep"* — plus a *"Nobody is asleep"* condition. There is no *everyone* variant,
and inverting *"Nobody is asleep"* gives you *"someone is asleep"*, which is not
the same thing. The usual workarounds are stacking one card per housemate (which
breaks the moment somebody joins) or writing a HomeyScript.

Both cards read your Homey user list **live, every time a Flow runs**, so adding
or removing a housemate never means editing a Flow.

## Requirements

- **Homey Pro.** The app needs the `homey:manager:api` permission to read the
  user list, and that permission is not available on Homey Cloud / Homey Bridge.
- Homey firmware 12.4.0 or newer.

The permission grants read-only Web API access. This app only ever reads the user
list; it never changes a user, a device or a Flow.

## Settings

The app settings page lists every Homey user with a tick box. Ticked users count
towards "everyone". Untick anyone who should not be able to hold the whole house
back — a guest account, or a phone that never reports presence. New Homey users
are counted automatically.

The page also shows what both cards would answer right now, which is the quickest
way to find out why one of them is unexpectedly false.

## How the edge cases are decided

- **A user whose presence has never been set** counts as *not* at home. Homey
  reports `null` rather than `false` for these, and "we don't know where they
  are" is not grounds to claim everyone is home. The settings page flags these
  users, since they are the usual reason a card is unexpectedly false.
- **Accounts disabled in Homey** are always ignored, whatever the settings say.
  A disabled account can never come home or fall asleep, so counting one would
  pin both cards to false forever.
- **If no users are counted at all** — every user unticked, or a brand new Homey
  — both cards return **false**, not true. "Every member of an empty set" is
  vacuously true, which here would silently fire *everyone is asleep*
  automations in an empty house.

## Development

```bash
npm install
npm run lint
homey app validate --level publish
homey app run          # live on your Homey Pro, logs the user list at startup
```

Store images are generated from the same geometry as `assets/icon.svg`:

```bash
python3 tools/genassets.py
```

## Affiliation

This is an unofficial community app. It is not affiliated with, authorised by, or
endorsed by Athom B.V. "Homey" is a trademark of Athom B.V., used here only to
describe which system this app is for, which is nominative fair use. No Athom
artwork, branding, logo or icon is included or reproduced. All artwork in this
app is original work created for it.
