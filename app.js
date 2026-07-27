'use strict';

const Homey = require('homey');
const { HomeyAPI } = require('homey-api');
const UserStatus = require('./lib/UserStatus');

/**
 * Extra User Statuses
 *
 * Homey ships presence and sleep Flow cards per user ("John is at home"), but no
 * household-wide ones. This app adds the two missing AND cards. They read the
 * Homey user list at evaluation time, so a household that gains or loses a user
 * never has to edit a Flow.
 */
class ExtraUserStatusesApp extends Homey.App {

  async onInit() {
    this.apiPromise = null;

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

    this.log('Extra User Statuses initialised.');
  }

  // ---------------------------------------------------------------------------
  // Homey Web API
  // ---------------------------------------------------------------------------

  /**
   * The Apps SDK has no users manager, so the user list comes from the Homey Web
   * API instead. Needs the homey:manager:api permission, which is read-only for
   * apps: everything this app does is a read, so that is enough.
   *
   * The instance is created once and reused. A failed attempt is not cached, so
   * a Homey that was not ready yet gets retried on the next card evaluation.
   */
  async getApi() {
    if (!this.apiPromise) {
      this.apiPromise = HomeyAPI.createAppAPI({ homey: this.homey })
        .catch((err) => {
          this.apiPromise = null;
          throw new Error(`Could not reach the Homey Web API: ${err.message}`);
        });
    }

    return this.apiPromise;
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

module.exports = ExtraUserStatusesApp;
