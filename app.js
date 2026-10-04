'use strict';

const Homey = require('homey');
const HomeyUsersApi = require('./lib/HomeyUsersApi');
const UserStatus = require('./lib/UserStatus');
const VacationStore = require('./lib/VacationStore');
const StatusRegistry = require('./lib/StatusRegistry');
const UserWatcher = require('./lib/UserWatcher');
const EventLog = require('./lib/EventLog');
const Tokens = require('./lib/Tokens');

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
    this.statuses = new StatusRegistry({ homey: this.homey, vacation: this.vacation });

    // Which household-wide status edge each status was last on, so 'everyone has
    // it' fires when it becomes true rather than on every later change.
    this.statusEdges = new Map();

    this.userStatus = new UserStatus({
      homey: this.homey,
      getApi: () => this.getApi(),
      vacation: this.vacation,
      statuses: this.statuses,
    });

    this.tokens = new Tokens({ homey: this.homey, userStatus: this.userStatus });

    this.registerFlowCards();
    this.wireStatusTriggers();
    this.watchLogSettings();

    // Not awaited, for the same reason the watcher is not: a slow Homey should
    // delay the tag values, not hold up the app.
    this.tokens.start().catch((err) => {
      this.error(`Could not create the Flow tags: ${err.message}`);
    });

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

    this.seedStatusEdges().catch((err) => {
      this.error(`Could not read the status state at startup: ${err.message}`);
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
        .catch((err) => this.record(this.homey.__('log.err_persist', { message: err.message }), 'error'));
    });
  }

  /**
   * Say it once, to both places: Homey's own app log for `homey app run`, and
   * the in-memory log the settings page shows.
   *
   * The two are not the same audience. Homey's app log is a diagnostic log: it
   * outlives the app, it is what a bug report carries, and a line naming who
   * came home or went to sleep makes it a timeline of the household's presence.
   * The in-app log is the household's own view, so names belong there and only
   * there. Whenever `message` names a person, pass a `diagnostic` line that does
   * not; it defaults to the message itself for the ones that never do.
   *
   * @param {string} message What the settings page shows.
   * @param {'info'|'trigger'|'error'} [level]
   * @param {string} [diagnostic] What Homey's app log gets, if `message` names someone.
   */
  record(message, level = 'info', diagnostic = message) {
    if (level === 'error') this.error(diagnostic);
    else this.log(diagnostic);

    this.eventLog.add(message, level);
  }

  // ---------------------------------------------------------------------------
  // Homey Web API
  // ---------------------------------------------------------------------------

  /**
   * The Apps SDK has no users manager, so the user list comes from the Homey Web
   * API instead. That needs the homey:manager:api permission, which is not a
   * read-only grant: getOwnerApiToken() starts a session on behalf of the Homey
   * owner. What is read-only is this app's use of it - one call, a GET of
   * /api/manager/users/user, and nothing is ever written back.
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
    const known = users.map((user) => user.id);
    for (const store of this.statuses.allStores()) await store.pruneUnknown(known);
    const described = users
      .map((user) => {
        const notes = [];
        if (user.onVacation) notes.push(this.homey.__('log.on_vacation'));
        else if (!user.counted) notes.push(this.homey.__('log.not_counted'));
        return `${user.name} (${user.role}${notes.length ? `, ${notes.join(', ')}` : ''})`;
      })
      .join(', ');

    this.record(
      this.homey.__('log.users_found', { count: users.length, counted: countedCount, list: described }),
      'info',
      `Found ${users.length} Homey user(s), counting ${countedCount}.`,
    );
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

    this.homey.flow.getConditionCard('count_users')
      .registerRunListener(async (args) => {
        const wanted = this.requireCount(args.count);
        const actual = await this.userStatus.countUsers(args.state);

        if (args.operator === 'min') return actual >= wanted;
        if (args.operator === 'max') return actual <= wanted;
        return actual === wanted;
      });

    this.homey.flow.getConditionCard('everyone_on_vacation')
      .registerRunListener(async () => this.userStatus.isEveryoneOnVacation());

    this.homey.flow.getConditionCard('nobody_on_vacation')
      .registerRunListener(async () => this.userStatus.isNobodyOnVacation());

    const userIsOnVacation = this.homey.flow.getConditionCard('user_on_vacation');
    userIsOnVacation.registerRunListener(async (args) => {
      const user = await this.requireUser(args.user);
      return this.userStatus.isUserOnVacation(user.id);
    });
    userIsOnVacation.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));

    // --- Triggers -------------------------------------------------------------
    this.triggerEveryoneHomeAsleep = this.homey.flow.getTriggerCard('everyone_home_became_asleep');
    this.triggerEveryoneAsleep = this.homey.flow.getTriggerCard('everyone_became_asleep');
    this.triggerFirstHomeAwake = this.homey.flow.getTriggerCard('first_home_awake');
    this.triggerFirstHomeAsleep = this.homey.flow.getTriggerCard('first_home_asleep');
    this.triggerFirstAsleep = this.homey.flow.getTriggerCard('first_asleep');
    this.triggerFirstAwake = this.homey.flow.getTriggerCard('first_awake');
    this.triggerSomeoneHomeAwake = this.homey.flow.getTriggerCard('someone_home_awake');
    this.triggerEveryoneHomeAwake = this.homey.flow.getTriggerCard('everyone_home_awake');
    this.triggerEveryoneAwake = this.homey.flow.getTriggerCard('everyone_awake');
    this.triggerEveryoneHomeArrived = this.homey.flow.getTriggerCard('everyone_home_arrived');
    this.triggerEveryoneLeft = this.homey.flow.getTriggerCard('everyone_left');
    this.triggerEveryoneVacationStarted = this.homey.flow.getTriggerCard('everyone_vacation_started');
    this.triggerEveryoneVacationEnded = this.homey.flow.getTriggerCard('everyone_vacation_ended');

    this.triggerVacationStarted = this.homey.flow.getTriggerCard('vacation_started');
    this.triggerVacationEnded = this.homey.flow.getTriggerCard('vacation_ended');

    for (const card of [this.triggerVacationStarted, this.triggerVacationEnded]) {
      this.registerUserPicker(card);
    }

    // --- One user at a time ---------------------------------------------------
    // Homey has cards for all four of these, and they fire for every account it
    // has: the guest phone that never reports where it is, the account somebody
    // disabled. These fire for the household this app was told to count, which
    // is the whole reason to replace Homey's with them.
    this.triggerUserLeft = this.homey.flow.getTriggerCard('user_left');
    this.triggerUserArrived = this.homey.flow.getTriggerCard('user_arrived');
    this.triggerUserAsleep = this.homey.flow.getTriggerCard('user_became_asleep');
    this.triggerUserAwake = this.homey.flow.getTriggerCard('user_woke_up');
    this.triggerFirstArrived = this.homey.flow.getTriggerCard('first_arrived');

    for (const card of [this.triggerUserLeft, this.triggerUserArrived, this.triggerUserAsleep, this.triggerUserAwake]) {
      this.registerUserPicker(card);
    }

    const userAtHome = this.homey.flow.getConditionCard('user_at_home');
    userAtHome.registerRunListener(async (args) => (await this.requireUser(args.user)).present === true);
    userAtHome.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));

    const userAsleep = this.homey.flow.getConditionCard('user_asleep');
    userAsleep.registerRunListener(async (args) => (await this.requireUser(args.user)).asleep === true);
    userAsleep.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));

    // --- Statuses in general --------------------------------------------------
    // Vacation keeps its own cards, which are shorter for the one status most
    // households use. These answer the same questions for any status at all.
    this.triggerStatusStarted = this.homey.flow.getTriggerCard('status_started');
    this.triggerStatusEnded = this.homey.flow.getTriggerCard('status_ended');
    this.triggerEveryoneStatusStarted = this.homey.flow.getTriggerCard('everyone_status_started');
    this.triggerEveryoneStatusEnded = this.homey.flow.getTriggerCard('everyone_status_ended');

    for (const card of [this.triggerStatusStarted, this.triggerStatusEnded]) {
      card.registerRunListener(async (args, state) => {
        if (args.status?.id !== state.statusId) return false;

        const wanted = args.user?.id;
        return !wanted || wanted === ANY_USER || wanted === state.userId;
      });
      card.registerArgumentAutocompleteListener('status', async (query) => this.autocompleteStatuses(query));
      card.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query, { includeAny: true }));
    }

    for (const card of [this.triggerEveryoneStatusStarted, this.triggerEveryoneStatusEnded]) {
      card.registerRunListener(async (args, state) => args.status?.id === state.statusId);
      card.registerArgumentAutocompleteListener('status', async (query) => this.autocompleteStatuses(query));
    }

    const userHasStatus = this.homey.flow.getConditionCard('user_has_status');
    userHasStatus.registerRunListener(async (args) => {
      if (!args.status?.id) throw new Error(this.homey.__('error.no_status'));
      const user = await this.requireUser(args.user);
      return this.statuses.has(args.status.id, user.id);
    });
    userHasStatus.registerArgumentAutocompleteListener('status', async (query) => this.autocompleteStatuses(query));
    userHasStatus.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));

    const everyoneHasStatus = this.homey.flow.getConditionCard('everyone_has_status');
    everyoneHasStatus.registerRunListener(async (args) => {
      const { eligible, held } = await this.statusTally(args.status?.id);
      return eligible > 0 && held === eligible;
    });
    everyoneHasStatus.registerArgumentAutocompleteListener('status', async (query) => this.autocompleteStatuses(query));

    const countStatus = this.homey.flow.getConditionCard('count_status');
    countStatus.registerRunListener(async (args) => {
      const wanted = this.requireCount(args.count);
      const { held } = await this.statusTally(args.status?.id);

      if (args.operator === 'min') return held >= wanted;
      if (args.operator === 'max') return held <= wanted;
      return held === wanted;
    });
    countStatus.registerArgumentAutocompleteListener('status', async (query) => this.autocompleteStatuses(query));

    const setStatus = this.homey.flow.getActionCard('set_status');
    setStatus.registerRunListener(async (args) => {
      const store = this.storeFor(args.status?.id);
      const user = await this.requireUser(args.user);

      const wanted = args.state === 'toggle' ? !store.has(user.id) : args.state === 'on';
      await store.set(user.id, wanted);

      return true;
    });
    setStatus.registerArgumentAutocompleteListener('status', async (query) => this.autocompleteStatuses(query));
    setStatus.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));

    const setStatusAll = this.homey.flow.getActionCard('set_status_all');
    setStatusAll.registerRunListener(async (args) => {
      const store = this.storeFor(args.status?.id);
      const ids = (await this.userStatus.getEligibleUsers()).map((user) => user.id);

      if (args.state === 'on') await store.setMany(ids, []);
      else await store.setMany([], ids);

      return true;
    });
    setStatusAll.registerArgumentAutocompleteListener('status', async (query) => this.autocompleteStatuses(query));

    // --- Actions --------------------------------------------------------------
    const setVacation = this.homey.flow.getActionCard('set_vacation');
    setVacation.registerRunListener(async (args) => {
      const user = await this.requireUser(args.user);

      const wanted = args.state === 'toggle'
        ? !this.vacation.isOnVacation(user.id)
        : args.state === 'on';

      await this.vacation.set(user.id, wanted);
      return true;
    });
    setVacation.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query));

    // Everyone at once, as a single write: the store collapses it into one
    // 'change' event, so the household cards fire once rather than per person.
    this.homey.flow.getActionCard('set_vacation_all')
      .registerRunListener(async (args) => {
        const ids = (await this.userStatus.getEligibleUsers()).map((user) => user.id);

        if (args.state === 'on') await this.vacation.setMany(ids, []);
        else await this.vacation.setMany([], ids);

        return true;
      });
  }

  /**
   * The 'this card is about one user, or about everybody' filter, shared by
   * every trigger that takes a user argument and nothing else.
   *
   * An empty or 'Any user' argument means the Flow wants every user, which is
   * what lets one card do the work of both "Alex comes home" and "somebody
   * comes home" - the second is the first with the argument left alone.
   */
  registerUserPicker(card) {
    card.registerRunListener(async (args, state) => {
      const wanted = args.user?.id;
      return !wanted || wanted === ANY_USER || wanted === state.userId;
    });
    card.registerArgumentAutocompleteListener('user', async (query) => this.autocompleteUsers(query, { includeAny: true }));
  }

  /**
   * The user a Flow card names, or a plain error.
   *
   * A card outlives the user it points at: somebody leaves the household and
   * their Homey account goes with them, while a Flow still names them. Answering
   * 'false' there is worse than failing - these cards are invertible, so a Flow
   * reading "if Alex is NOT at home, arm the alarm" would start arming it the
   * moment Alex's account was deleted, silently and for ever. Failing loudly
   * puts it in the Flow's own error instead, which is the same call storeFor()
   * makes one screen down for a status that no longer exists.
   *
   * @param {{ id?: string, name?: string }} arg The card's user argument.
   */
  async requireUser(arg) {
    if (!arg?.id) throw new Error(this.homey.__('error.no_user'));

    const user = await this.userStatus.getUser(arg.id);
    if (!user) throw new Error(this.homey.__('error.no_such_user', { name: arg.name || arg.id }));

    return user;
  }

  /**
   * The number a counting card compares against, or a plain error.
   *
   * Number() of anything that is not a number is NaN, and every comparison with
   * NaN is false. These cards are invertible, so "if fewer than NaN are home"
   * would quietly answer the same way for ever instead of saying the Flow's
   * argument is broken.
   *
   * @param {unknown} value The card's count argument.
   * @returns {number}
   */
  requireCount(value) {
    const count = Number(value);
    if (!Number.isFinite(count)) throw new Error(this.homey.__('error.invalid_request'));

    return count;
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

  /** Feeds every status-picking argument from the live registry. */
  async autocompleteStatuses(query) {
    const items = this.statuses.list().map((status) => ({ id: status.id, name: status.name }));

    if (!query) return items;

    const needle = query.toLowerCase();
    return items.filter((item) => item.name.toLowerCase().includes(needle));
  }

  /**
   * The store for a status a Flow card names, or a plain error.
   *
   * A card can outlive the status it points at - somebody deletes 'Working from
   * home' while a Flow still sets it. Failing here makes that visible in the
   * Flow's own error, rather than writing into a settings key nobody reads.
   */
  storeFor(statusId) {
    const store = statusId && this.statuses.store(statusId);
    if (!store) {
      throw new Error(statusId
        ? this.homey.__('error.no_such_status', { name: statusId })
        : this.homey.__('error.no_status'));
    }

    return store;
  }

  /** How many of the users who count hold a status, and how many there are. */
  async statusTally(statusId) {
    const store = this.storeFor(statusId);
    const eligible = await this.userStatus.getEligibleUsers();

    return { eligible: eligible.length, held: eligible.filter((user) => store.has(user.id)).length };
  }

  // ---------------------------------------------------------------------------
  // Reacting to change
  // ---------------------------------------------------------------------------

  wireWatcher() {
    // Every card that names somebody is the same three steps - say it in the
    // log, fire the card with the name as its tag, and never let a broken Flow
    // take the watcher down with it - so they are described rather than written
    // out.
    const namedCards = [
      { event: 'everyone-home-asleep', logKey: 'log.last_asleep', card: () => this.triggerEveryoneHomeAsleep },
      { event: 'everyone-asleep', logKey: 'log.last_asleep_any', card: () => this.triggerEveryoneAsleep },
      { event: 'first-home-awake', logKey: 'log.first_awake', card: () => this.triggerFirstHomeAwake },
      { event: 'someone-home-awake', logKey: 'log.someone_home_awake', card: () => this.triggerSomeoneHomeAwake },
      { event: 'first-home-asleep', logKey: 'log.first_home_asleep', card: () => this.triggerFirstHomeAsleep },
      { event: 'first-asleep', logKey: 'log.first_asleep', card: () => this.triggerFirstAsleep },
      { event: 'first-awake', logKey: 'log.first_awake_any', card: () => this.triggerFirstAwake },
      { event: 'everyone-home-awake', logKey: 'log.last_awake', card: () => this.triggerEveryoneHomeAwake },
      { event: 'everyone-awake', logKey: 'log.last_awake_any', card: () => this.triggerEveryoneAwake },
      { event: 'first-arrived', logKey: 'log.first_arrived', card: () => this.triggerFirstArrived },
    ];

    for (const { event, logKey, card } of namedCards) {
      this.watcher.on(event, ({ name }) => {
        this.record(this.homey.__(logKey, { name }), 'trigger', `Trigger fired: ${event}.`);
        card().trigger({ user: name }).catch((err) => this.error(err.message));
      });
    }

    // The two household cards that name nobody. They take no tokens, so they
    // cannot ride along in the table above.
    const householdCards = [
      { event: 'everyone-home', logKey: 'log.everyone_home', card: () => this.triggerEveryoneHomeArrived },
      { event: 'everyone-left', logKey: 'log.everyone_left', card: () => this.triggerEveryoneLeft },
    ];

    for (const { event, logKey, card } of householdCards) {
      this.watcher.on(event, () => {
        this.record(this.homey.__(logKey), 'trigger');
        card().trigger().catch((err) => this.error(err.message));
      });
    }

    // The four per-user cards. They cannot ride along in the table above: the
    // run listener has to know which user this was about in order to decide
    // whether a Flow that named somebody should run, and that travels as state
    // rather than as a tag.
    //
    // No log line either - the 'user-changed' handler below already records
    // these four transitions, and saying it twice would only pad a log whose
    // whole job is to be readable. It records a superset, not the same set:
    // 'user-changed' comes from every user, these cards only from the ones who
    // count. A log line with no card behind it is the right way round for a log
    // that exists to explain why a card did *not* fire.
    const userCards = [
      { event: 'user-left', card: () => this.triggerUserLeft },
      { event: 'user-arrived', card: () => this.triggerUserArrived },
      { event: 'user-asleep', card: () => this.triggerUserAsleep },
      { event: 'user-awake', card: () => this.triggerUserAwake },
    ];

    for (const { event, card } of userCards) {
      this.watcher.on(event, ({ id, name }) => {
        card().trigger({ user: name }, { userId: id }).catch((err) => this.error(err.message));
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

      this.record(this.homey.__(key, { name }), 'info', `A user's ${field} changed to ${value}.`);

      // The tags describe the household, so every change to it moves them.
      this.tokens.refresh().catch((err) => this.error(err.message));
    });

    this.watcher.on('arrived', ({ id, name }) => {
      // Coming home is taken as evidence the status is over. Opt-out per status,
      // because some households will want vacation to end only when a Flow says
      // so - and a status like 'do not disturb' should never end by itself.
      for (const status of this.statuses.autoReturning()) {
        const store = this.statuses.store(status.id);
        if (!store || !store.has(id)) continue;

        this.record(
          status.id === StatusRegistry.VACATION
            ? this.homey.__('log.auto_return', { name })
            : this.homey.__('log.auto_return_status', { name, status: status.name }),
          'info',
          `A user came home, so the status ${status.id} was cleared.`,
        );

        store.set(id, false).catch((err) => this.error(err.message));
      }
    });
  }

  /**
   * Every status change - Flow, device, settings page or auto-return - lands
   * here, so the triggers fire exactly once regardless of what caused it.
   */
  wireStatusTriggers() {
    for (const status of this.statuses.list()) this.subscribeToStatus(status.id);

    // A status the user invents later needs the same wiring. Subscribing is
    // idempotent, so re-running it for statuses already wired costs nothing.
    this.statuses.on('statuses-changed', () => {
      const live = new Set();
      for (const status of this.statuses.list()) {
        live.add(status.id);
        this.subscribeToStatus(status.id);
      }

      // A deleted status leaves its household-wide edge behind otherwise, and
      // the id can be reused: the new status would then inherit the old one's
      // 'everyone had it' and fire - or swallow - a trigger on that basis.
      for (const id of [...this.statusEdges.keys()]) {
        if (!live.has(id)) this.statusEdges.delete(id);
      }

      // Nothing else tells a tile its status is gone. The store only emits for
      // changes to who holds a status, and a deleted status is not one.
      this.checkStatusDevices();

      this.tokens.refresh().catch((err) => this.error(err.message));
    });
  }

  subscribeToStatus(statusId) {
    const store = this.statuses.store(statusId);
    if (!store || store.listenerCount('change') > 0) return;

    store.on('change', ({ added, removed }) => {
      this.onStatusChanged(statusId, { added, removed }).catch((err) => {
        this.error(`Status triggers failed for ${statusId}: ${err.message}`);
      });
    });
  }

  /**
   * Gives the household-wide status triggers a 'before' to compare against.
   *
   * Without this they start out unset, and 'nobody has it any more' needs a
   * previous value of exactly false to fire. An app that restarted while
   * somebody held the status - which is every Homey reboot and every app update
   * during a fortnight's holiday - would then swallow that trigger when the
   * status ended. The same gap fires 'everyone has it' a second time for a
   * household that already did.
   */
  async seedStatusEdges() {
    for (const status of this.statuses.list()) {
      const { eligible, held } = await this.statusTally(status.id);

      // A change that landed while we were reading has already set this from the
      // newer state, so it must not be overwritten with the older one.
      if (this.statusEdges.has(status.id)) continue;

      this.statusEdges.set(status.id, { everyone: eligible > 0 && held === eligible, nobody: held === 0 });
    }
  }

  /**
   * @param {string} statusId
   * @param {{ added: string[], removed: string[] }} change
   */
  async onStatusChanged(statusId, { added, removed }) {
    const status = this.statuses.get(statusId);
    if (!status) return;

    const isVacation = statusId === StatusRegistry.VACATION;

    // The tags describe who counts, and an excluding status changes that.
    this.tokens.refresh().catch((err) => this.error(err.message));

    // Reflect the new state before announcing it. A tile showing the truth must
    // not depend on whether firing a Flow trigger happened to succeed, or the
    // device drifts out of step with the store - the exact failure the device
    // was introduced to prevent.
    this.syncStatusDevices(statusId);

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

    for (const [ids, generic, legacy, logKey] of [
      [added, this.triggerStatusStarted, this.triggerVacationStarted, 'log.vacation_started'],
      [removed, this.triggerStatusEnded, this.triggerVacationEnded, 'log.vacation_ended'],
    ]) {
      for (const id of ids) {
        // Vacation says it in its own words; every other status shares one line,
        // naming itself. Logging both for vacation would say it twice.
        const started = generic === this.triggerStatusStarted;
        this.record(
          isVacation
            ? this.homey.__(logKey, { name: nameOf(id) })
            : this.homey.__(started ? 'log.status_started' : 'log.status_ended', {
              name: nameOf(id), status: status.name,
            }),
          'trigger',
          `The status ${statusId} ${started ? 'started' : 'ended'} for a user.`,
        );

        await fire(generic, { user: nameOf(id), status: status.name }, { statusId, userId: id });
        if (isVacation) await fire(legacy, { user: nameOf(id) }, { userId: id });
      }
    }

    // Household-wide cards fire on the edge, so "everyone has it" runs once when
    // the last person takes it on rather than on every subsequent change.
    const { eligible, held } = await this.statusTally(statusId);
    const everyone = eligible > 0 && held === eligible;
    const nobody = held === 0;
    const before = this.statusEdges.get(statusId) || {};

    if (everyone && before.everyone === false) {
      await fire(this.triggerEveryoneStatusStarted, { status: status.name }, { statusId });
      if (isVacation) await fire(this.triggerEveryoneVacationStarted);
    }
    if (nobody && before.nobody === false) {
      await fire(this.triggerEveryoneStatusEnded, { status: status.name }, { statusId });
      if (isVacation) await fire(this.triggerEveryoneVacationEnded);
    }

    this.statusEdges.set(statusId, { everyone, nobody });
  }

  /**
   * Keeps every paired tile for one status showing the truth from its store.
   *
   * Two drivers to cover: 'vacation', which predates statuses and whose devices
   * are all about vacation, and 'status', whose devices each name the status
   * they belong to. A device of the wrong status is skipped rather than told to
   * resync, so a household with a dozen tiles does a dozen no-ops at most.
   *
   * Also called once at startup: a device can initialise before this app does,
   * and a device that lost that race would otherwise sit showing no value at all.
   *
   * @param {string} statusId
   */
  syncStatusDevices(statusId) {
    for (const driverId of ['vacation', 'status']) {
      if (driverId === 'vacation' && statusId !== StatusRegistry.VACATION) continue;

      try {
        const driver = this.homey.drivers.getDriver(driverId);
        if (!driver) continue;

        for (const device of driver.getDevices()) {
          if (typeof device.syncFromStore !== 'function') continue;
          if (driverId === 'status' && device.statusId !== statusId) continue;

          device.syncFromStore().catch((err) => this.error(`Device sync failed: ${err.message}`));
        }
      } catch (err) {
        this.error(`Could not reach the ${driverId} devices: ${err.message}`);
      }
    }
  }

  /**
   * Has every status tile re-check that its status and user still exist, so a
   * tile whose status was just deleted goes unavailable straight away instead of
   * at the next app start.
   */
  checkStatusDevices() {
    try {
      const driver = this.homey.drivers.getDriver('status');
      if (!driver) return;

      for (const device of driver.getDevices()) {
        if (typeof device.checkStillValid !== 'function') continue;

        device.checkStillValid().catch((err) => this.error(`Device check failed: ${err.message}`));
      }
    } catch (err) {
      this.error(`Could not reach the status devices: ${err.message}`);
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
      // The settings page runs in the browser of whoever opens it, which may be
      // in another timezone than the house. The log should read as the house's
      // clock does.
      timezone: this.homey.clock.getTimezone(),
    };
  }

  clearLog() {
    this.eventLog.clear();
    this.record(this.homey.__('log.cleared'));
    return this.getLog();
  }

  /**
   * The second half of the door api.js guards: an id of the right shape that no
   * Homey user has would otherwise be stored, and then sit in settings until the
   * next start prunes it.
   *
   * @param {string} userId
   */
  async requireKnownUser(userId) {
    if (!(await this.userStatus.getUser(userId))) {
      throw new Error(this.homey.__('error.unknown_user'));
    }
  }

  async setVacation(userId, onVacation) {
    await this.requireKnownUser(userId);
    await this.vacation.set(userId, Boolean(onVacation));
    return this.getOverview();
  }

  // ---------------------------------------------------------------------------
  // Statuses, for the settings page
  // ---------------------------------------------------------------------------

  /** Every status with who holds it, in one round trip. */
  async getStatuses() {
    const users = await this.userStatus.fetchUsers();

    return {
      // The settings page enforces the same limits the registry does, so it is
      // told them rather than keeping a second copy that could drift.
      limits: { maxStatuses: StatusRegistry.MAX_CUSTOM, maxNameLength: StatusRegistry.MAX_NAME },
      statuses: this.statuses.list().map((status) => ({
        ...status,
        userIds: this.statuses.store(status.id).getIds().filter((id) => users.some((user) => user.id === id)),
      })),
      users: users.map((user) => ({ id: user.id, name: user.name, enabled: user.enabled })),
    };
  }

  async setStatus(statusId, userId, held) {
    const store = this.storeFor(statusId);
    await this.requireKnownUser(userId);
    await store.set(userId, Boolean(held));

    return this.getStatuses();
  }

  async saveStatuses(list) {
    await this.statuses.saveCustom(list);
    this.record(this.homey.__('log.statuses_saved'));

    return this.getStatuses();
  }

}

module.exports = AdditionalUserStatusesApp;
