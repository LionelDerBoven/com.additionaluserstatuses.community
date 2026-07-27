'use strict';

const Homey = require('homey');
const HomeyUsersApi = require('./lib/HomeyUsersApi');
const UserStatus = require('./lib/UserStatus');

/**
 * Additional User Statuses
 *
 * Homey ships presence and sleep Flow cards per user ("John is at home"), but no
 * household-wide ones. This app adds the two missing AND cards. They read the
 * Homey user list at evaluation time, so a household that gains or loses a user
 * never has to edit a Flow.
 */
class AdditionalUserStatusesApp extends Homey.App {

  async onInit() {
    this.api = null;

    this.userStatus = new UserStatus({
      homey: this.homey,
      getApi: () => this.getApi(),
    });

    this.registerFlowCards();

    // Not awaited: a Homey that is slow to answer should delay the first card
    // evaluation, not block the app from starting.
    this.logUsersOnce().catch((err) => {
      this.error(`Could not read the Homey users at startup: ${err.message}`);
    });

    this.log('Additional User Statuses initialised.');
  }

  // ---------------------------------------------------------------------------
  // Homey Web API
  // ---------------------------------------------------------------------------

  /**
   * The Apps SDK has no users manager, so the user list comes from the Homey Web
   * API instead. Needs the homey:manager:api permission, which is read-only for
   * apps: everything this app does is a read, so that is enough.
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
    const described = users
      .map((user) => `${user.name} (${user.role}${user.counted ? '' : ', not counted'})`)
      .join(', ');

    this.log(`Found ${users.length} Homey user(s), counting ${countedCount}: ${described}`);
  }

  // ---------------------------------------------------------------------------
  // Flow cards
  // ---------------------------------------------------------------------------

  registerFlowCards() {
    this.homey.flow.getConditionCard('everyone_home')
      .registerRunListener(async () => this.userStatus.isEveryoneHome());

    this.homey.flow.getConditionCard('everyone_asleep')
      .registerRunListener(async () => this.userStatus.isEveryoneAsleep());
  }

  // ---------------------------------------------------------------------------
  // Settings page API (see api.js)
  // ---------------------------------------------------------------------------

  async getOverview() {
    return this.userStatus.getOverview();
  }

}

module.exports = AdditionalUserStatusesApp;
