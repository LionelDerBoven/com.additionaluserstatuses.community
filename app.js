'use strict';

const Homey = require('homey');
const HomeyUsersApi = require('./lib/HomeyUsersApi');
const UserStatus = require('./lib/UserStatus');
const VacationStore = require('./lib/VacationStore');
const UserWatcher = require('./lib/UserWatcher');
const EventLog = require('./lib/EventLog');

// Sentinel id for the "Any user" entry in trigger autocompletes.
const ANY_USER = '*';

/**
 * Additional User Statuses
 *
 * Homey ships presence and sleep Flow cards per user ("John is at home"), but no
 * household-wide ones, and no concept of a holiday at all. This app adds both.
 * Everything is read from the live Homey user list at evaluation time, so a
 * household that gains or loses a user never has to edit a Flow.
 */
class AdditionalUserStatusesApp extends Homey.App {

  async onInit() {
    this.api = null;

    this.eventLog = new EventLog({ homey: this.homey });
    this.vacation = new VacationStore({ homey: this.homey });

    this.userStatus = new UserStatus({
      homey: this.homey,
      getApi: () => this.getApi(),
      vacation: this.vacation,
    });

    this.registerFlowCards();
    this.wireVacationTriggers();
    this.watchLogSettings();

    this.watcher = new UserWatcher({ homey: this.homey, userStatus: this.userStatus });
    this.wireWatcher();

    // Not awaited: a Homey that is slow to answer should delay the first trigger,
    // not block the app from starting.
    this.watcher.start().catch((err) => {
      this.record(this.homey.__('log.err_watcher', { message: err.message }), 'error');
    });

    this.logUsersOnce().catch((err) => {
      this.record(this.homey.__('log.err_users', { message: err.message }), 'error');
    });

    this.seedVacationEdges().catch((err) => {
      this.error(`Could not read the vacation state at startup: ${err.message}`);
    });

    // Devices are deliberately not synced from here: at this point Homey has not
    // initialised the drivers yet, so getDriver() throws. Each device waits for
    // this app's store instead, in VacationDevice#getStore.

    this.record(this.homey.__('log.app_started'));
  }

  async onUninit() {
    if (this.watcher) this.watcher.stop();
    if (this.eventLog) await this.eventLog.stop();
  }

  /**
   * The log settings apply the moment they are ticked, so the app has to notice
   * rather than wait for anything to be saved.
   */
  watchLogSettings() {
    this.homey.settings.on('set', (key) => {
      if (key !== 'log_persist') return;

      const persist = this.homey.settings.get('log_persist') === true;
      this.record(this.homey.__(persist ? 'log.persist_on' : 'log.persist_off'));

      this.eventLog.onPersistChanged(persist)
        .catch((err) => this.error(`Could not change log persistence: ${err.message}`));
    });
  }

  /**
   * Say it once, to both places: Homey's own app log for `homey app run`, and
   * the in-memory log the settings page shows.
   *
   * @param {string} message
   * @param {'info'|'trigger'|'error'} [level]
   */
  record(message, level = 'info') {
    if (level === 'error') this.error(message);
    else this.log(message);

    this.eventLog.add(message, level);
  }

  // ---------------------------------------------------------------------------
  // Homey Web API
  // ---------------------------------------------------------------------------

  /**
   * The Apps SDK has no users manager, so the user list comes from the Homey Web
   * API instead. Needs the homey:manager:api permission, which is read-only for
   * apps: everything this app reads from Homey is a read, so that is enough.
   *
   * Constructing the client is synchronous and cannot fail - it defers the token
   * until the first actual request - so there is nothing to retry here.
   */
  async getApi() {
    if (!this.api) {
      this.api = new HomeyUsersApi({ homey: this.homey });
    }

    return this.api;
  }

  async logUsersOnce() {
    const { users, countedCount } = await this.userStatus.getOverview();

    // Someone deleted from Homey while on vacation would otherwise leave their
    // id in settings for ever. Done here rather than on a timer, so a Homey we
    // briefly could not read is never mistaken for "these users are all gone".
    await this.vacation.pruneUnknown(users.map((user) => user.id));
    const described = users
      .map((user) => {
        const notes = [];
        if (user.onVacation) notes.push(this.homey.__('log.on_vacation'));
        else if (!user.counted) notes.push(this.homey.__('log.not_counted'));
        return `${user.name} (${user.role}${notes.length ? `, ${notes.join(', ')}` : ''})`;
      })
      .join(', ');

    this.record(this.homey.__('log.users_found', { count: users.length, counted: countedCount, list: described }));
  }

  // ---------------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------------

  registerFlowCards() {
    // --- Conditions -----------------------------------------------------------
    this.homey.flow.getConditionCard('everyone_home')
      .registerRunListener(async () => this.userStatus.isEveryoneHome());

    this.homey.flow.getConditionCard('everyone_asleep')
      .registerRunListener(async () => this.userStatus.isEveryoneAsleep());

    this.homey.flow.getConditionCard('everyone_home_asleep')
      .registerRunListener(async () => this.userStatus.isEveryoneHomeAsleep());

    this.homey.flow.getConditionCard('one_home_awake')
      .registerRunListener(async () => this.userStatus.isExactlyOneHomeAwake());

    this.homey.flow.getConditionCard('everyone_on_vacation')
      .registerRunListener(async () => this.userStatus.isEveryoneOnVacation());

    this.homey.flow.getConditionCard('nobody_on_vacation')
      .registerRunListener(async () => this.userStatus.isNobodyOnVacation());

    const userIsOnVacation = this.homey.flow.getConditionCard('user_on_vacation');
    userIsOnVacation.registerRunListener(async (args) => {
      if (!args.user?.id) throw new Error('No user selected.');
      return this.userStatus.isUserOnVacation(args.user.id);
    });
    userIsOnVacation.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));

    // --- Triggers -------------------------------------------------------------
    this.triggerEveryoneHomeAsleep = this.homey.flow.getTriggerCard('everyone_home_became_asleep');
    this.triggerEveryoneAsleep = this.homey.flow.getTriggerCard('everyone_became_asleep');
    this.triggerFirstHomeAwake = this.homey.flow.getTriggerCard('first_home_awake');
    this.triggerFirstHomeAsleep = this.homey.flow.getTriggerCard('first_home_asleep');
    this.triggerFirstAsleep = this.homey.flow.getTriggerCard('first_asleep');
    this.triggerFirstAwake = this.homey.flow.getTriggerCard('first_awake');
    this.triggerEveryoneVacationStarted = this.homey.flow.getTriggerCard('everyone_vacation_started');
    this.triggerEveryoneVacationEnded = this.homey.flow.getTriggerCard('everyone_vacation_ended');

    this.triggerVacationStarted = this.homey.flow.getTriggerCard('vacation_started');
    this.triggerVacationEnded = this.homey.flow.getTriggerCard('vacation_ended');

    for (const card of [this.triggerVacationStarted, this.triggerVacationEnded]) {
      // An empty or 'Any user' argument means the Flow wants every user.
      card.registerRunListener(async (args, state) => {
        const wanted = args.user?.id;
        return !wanted || wanted === ANY_USER || wanted === state.userId;
      });
      card.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query, { includeAny: true }));
    }

    // --- Actions --------------------------------------------------------------
    const setVacation = this.homey.flow.getActionCard('set_vacation');
    setVacation.registerRunListener(async (args) => {
      if (!args.user?.id) throw new Error('No user selected.');
      await this.vacation.set(args.user.id, args.state === 'on');
      return true;
    });
    setVacation.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));
  }

  /**
   * Feeds every user-picking argument from the live Homey user list, so a new
   * housemate shows up without the app being touched.
   */
  async autocompleteUsers(query, { includeAny = false } = {}) {
    const users = await this.userStatus.getEligibleUsers();

    const items = users
      .map((user) => ({ id: user.id, name: user.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    if (includeAny) {
      items.unshift({ id: ANY_USER, name: this.homey.__('any_user') });
    }

    if (!query) return items;

    const needle = query.toLowerCase();
    return items.filter((item) => item.name.toLowerCase().includes(needle));
  }

  // ---------------------------------------------------------------------------
  // Reacting to change
  // ---------------------------------------------------------------------------

  wireWatcher() {
    // Every sleep card is the same three steps - say it in the log, fire the
    // card with the name as its tag, and never let a broken Flow take the
    // watcher down with it - so they are described rather than written out.
    const sleepCards = [
      { event: 'everyone-home-asleep', logKey: 'log.last_asleep', card: () => this.triggerEveryoneHomeAsleep },
      { event: 'everyone-asleep', logKey: 'log.last_asleep_any', card: () => this.triggerEveryoneAsleep },
      { event: 'first-home-awake', logKey: 'log.first_awake', card: () => this.triggerFirstHomeAwake },
      { event: 'first-home-asleep', logKey: 'log.first_home_asleep', card: () => this.triggerFirstHomeAsleep },
      { event: 'first-asleep', logKey: 'log.first_asleep', card: () => this.triggerFirstAsleep },
      { event: 'first-awake', logKey: 'log.first_awake_any', card: () => this.triggerFirstAwake },
    ];

    for (const { event, logKey, card } of sleepCards) {
      this.watcher.on(event, ({ name }) => {
        this.record(this.homey.__(logKey, { name }), 'trigger');
        card().trigger({ user: name }).catch((err) => this.error(err.message));
      });
    }

    // Raw status changes, so the log explains why a card did or did not fire.
    this.watcher.on('user-changed', ({ name, field, value }) => {
      const key = {
        'present:true': 'log.came_home',
        'present:false': 'log.went_away',
        'asleep:true': 'log.went_to_sleep',
        'asleep:false': 'log.woke_up',
      }[`${field}:${value}`];

      this.record(this.homey.__(key, { name }));
    });

    this.watcher.on('arrived', ({ id, name }) => {
      // Coming home is taken as evidence the holiday is over. Opt-out, because
      // some households will want vacation to end only when a Flow says so.
      if (!this.vacation.isAutoReturnEnabled()) return;
      if (!this.vacation.isOnVacation(id)) return;

      this.record(this.homey.__('log.auto_return', { name }));
      this.vacation.set(id, false).catch((err) => this.error(err.message));
    });
  }

  /**
   * Every vacation change - Flow, device, settings page or auto-return - lands
   * here, so the triggers fire exactly once regardless of what caused it.
   */
  wireVacationTriggers() {
    this.vacation.on('change', ({ added, removed }) => {
      this.onVacationChanged({ added, removed }).catch((err) => {
        this.error(`Vacation triggers failed: ${err.message}`);
      });
    });
  }

  /**
   * Gives the household-wide vacation triggers a 'before' to compare against.
   *
   * Without this they start out undefined, and 'nobody is on vacation any more'
   * needs a previous value of exactly false to fire. An app that restarted while
   * somebody was away - which is every Homey reboot and every app update during
   * a fortnight's holiday - would then swallow that trigger when the holiday
   * ended. The same gap fires 'everyone is on vacation' a second time for a
   * household that already was.
   */
  async seedVacationEdges() {
    const everyone = await this.userStatus.isEveryoneOnVacation();
    const nobody = await this.userStatus.isNobodyOnVacation();

    // A change that landed while we were reading has already set these from the
    // newer state, so it must not be overwritten with the older one.
    if (this.lastEveryoneOnVacation === undefined) this.lastEveryoneOnVacation = everyone;
    if (this.lastNobodyOnVacation === undefined) this.lastNobodyOnVacation = nobody;
  }

  async onVacationChanged({ added, removed }) {
    // Reflect the new state before announcing it. A tile showing the truth must
    // not depend on whether firing a Flow trigger happened to succeed, or the
    // device drifts out of step with the store - the exact failure the device
    // was introduced to prevent.
    this.syncVacationDevices();

    const users = await this.userStatus.fetchUsers();
    const nameOf = (id) => users.find((user) => user.id === id)?.name ?? this.homey.__('unnamed_user');

    // Each trigger is fired independently: one Flow card failing should not stop
    // the rest, nor the household-wide cards below.
    const fire = async (card, tokens, state) => {
      try {
        await card.trigger(tokens, state);
      } catch (err) {
        this.record(this.homey.__('log.err_trigger', { message: err.message }), 'error');
      }
    };

    for (const id of added) {
      this.record(this.homey.__('log.vacation_started', { name: nameOf(id) }), 'trigger');
      await fire(this.triggerVacationStarted, { user: nameOf(id) }, { userId: id });
    }
    for (const id of removed) {
      this.record(this.homey.__('log.vacation_ended', { name: nameOf(id) }), 'trigger');
      await fire(this.triggerVacationEnded, { user: nameOf(id) }, { userId: id });
    }

    // Household-wide cards fire on the edge, so "everyone is on vacation" runs
    // once when the last person leaves rather than on every subsequent change.
    const everyone = await this.userStatus.isEveryoneOnVacation();
    const nobody = await this.userStatus.isNobodyOnVacation();

    if (everyone && !this.lastEveryoneOnVacation) {
      await fire(this.triggerEveryoneVacationStarted);
    }
    if (nobody && this.lastNobodyOnVacation === false) {
      await fire(this.triggerEveryoneVacationEnded);
    }

    this.lastEveryoneOnVacation = everyone;
    this.lastNobodyOnVacation = nobody;
  }

  /**
   * Keeps every paired vacation device showing the truth from the store.
   *
   * Also called once at startup: a device can initialise before this app does,
   * and a device that lost that race would otherwise sit showing no value at all.
   */
  syncVacationDevices() {
    try {
      const driver = this.homey.drivers.getDriver('vacation');
      if (!driver) return;

      for (const device of driver.getDevices()) {
        if (typeof device.syncFromStore === 'function') {
          device.syncFromStore().catch((err) => this.error(`Device sync failed: ${err.message}`));
        }
      }
    } catch (err) {
      this.error(`Could not reach the vacation devices: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings page API (see api.js)
  // ---------------------------------------------------------------------------

  async getOverview() {
    return this.userStatus.getOverview();
  }

  getLog() {
    return {
      entries: this.eventLog.list(),
      ...this.getLogPrefs(),
    };
  }

  /**
   * The 24-hour default follows the Homey's own language: English is the only
   * one of Homey's languages where a 12-hour clock is the everyday norm.
   */
  getLogPrefs() {
    const stored = this.homey.settings.get('log_24h');
    const language = this.homey.i18n.getLanguage();

    return {
      persist: this.homey.settings.get('log_persist') === true,
      use24Hour: typeof stored === 'boolean' ? stored : language !== 'en',
      language,
    };
  }

  clearLog() {
    this.eventLog.clear();
    this.record(this.homey.__('log.cleared'));
    return this.getLog();
  }

  async setVacation(userId, onVacation) {
    await this.vacation.set(userId, Boolean(onVacation));
    return this.getOverview();
  }

}

module.exports = AdditionalUserStatusesApp;
