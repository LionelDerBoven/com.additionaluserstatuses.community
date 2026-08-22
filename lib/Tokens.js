'use strict';

/** The tag value for a list of people: "Alex, Sam", or empty for nobody. */
function names(users) {
  return users.map((user) => user.name).join(', ');
}

/**
 * What every tag holds, and how to work it out.
 *
 * `of` receives the counted household first, because that is what nearly every
 * tag describes, and the full list second - only the vacation tags need it,
 * since they count exactly the people the counted list leaves out.
 */
const TOKENS = [
  {
    id: 'count_home',
    type: 'number',
    of: (counted) => counted.filter((user) => user.present).length,
  },
  {
    id: 'count_away',
    type: 'number',
    of: (counted) => counted.filter((user) => !user.present).length,
  },
  {
    id: 'count_awake',
    type: 'number',
    of: (counted) => counted.filter((user) => !user.asleep).length,
  },
  {
    id: 'count_asleep',
    type: 'number',
    of: (counted) => counted.filter((user) => user.asleep).length,
  },
  {
    id: 'count_vacation',
    type: 'number',
    of: (counted, all) => all.filter((user) => user.onVacation).length,
  },
  {
    id: 'names_home',
    type: 'string',
    of: (counted) => names(counted.filter((user) => user.present)),
  },
  {
    id: 'names_awake',
    type: 'string',
    of: (counted) => names(counted.filter((user) => !user.asleep)),
  },
  {
    id: 'names_vacation',
    type: 'string',
    of: (counted, all) => names(all.filter((user) => user.onVacation)),
  },
];

/**
 * Global Flow tags for the household, so a Flow can ask "how many people are
 * home" without a card at all.
 *
 * Homey has no such tags of its own: its presence tags exist only inside the
 * trigger that produced them, which is no help to a Flow that starts from a
 * button or a time. These are always readable, from any Flow.
 *
 * The counting tags follow the same household the cards do - anyone on vacation,
 * unticked in the settings, or disabled in Homey is left out - so a tag and a
 * card can never disagree. The vacation tags are the exception by necessity:
 * they count the people the others leave out.
 */
class Tokens {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   * @param {import('./UserStatus')} opts.userStatus
   */
  constructor({ homey, userStatus }) {
    this.homey = homey;
    this.userStatus = userStatus;
    this.tokens = new Map();
    this.pending = null;
  }

  /**
   * Registers every tag, then fills them in. Registration is separate from the
   * first read so a Homey that is slow to answer delays the values, not the
   * tags: a tag that shows up late is a tag missing from the Flow editor.
   */
  async start() {
    for (const spec of TOKENS) {
      const token = await this.homey.flow.createToken(spec.id, {
        type: spec.type,
        title: this.homey.__(`token.${spec.id}`),
        value: spec.type === 'number' ? 0 : '',
      });

      this.tokens.set(spec.id, token);
    }

    await this.refresh();
  }

  /**
   * Recomputes every tag from a single overview.
   *
   * Callers are events - a presence change, a vacation change - and those arrive
   * in bursts, so overlapping refreshes share one read rather than each fetching
   * the user list. UserStatus caches for two seconds on top of that.
   */
  async refresh() {
    if (this.pending) return this.pending;

    this.pending = this.read()
      .finally(() => {
        this.pending = null;
      });

    return this.pending;
  }

  async read() {
    const { users } = await this.userStatus.getOverview();
    const counted = users.filter((user) => user.counted);

    for (const spec of TOKENS) {
      const token = this.tokens.get(spec.id);
      if (!token) continue;

      // One failing tag must not stop the rest: they are independent readings,
      // and a stale number is better than eight stale numbers.
      try {
        await token.setValue(spec.of(counted, users));
      } catch (err) {
        this.homey.app.error(`Could not update the tag ${spec.id}: ${err.message}`);
      }
    }
  }

}

module.exports = Tokens;
module.exports.TOKENS = TOKENS;
