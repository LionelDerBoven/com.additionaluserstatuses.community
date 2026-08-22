'use strict';

const StatusStore = require('./StatusStore');

const VACATION_SETTING = 'vacation_user_ids';
const AUTO_RETURN_SETTING = 'vacation_auto_return';

/**
 * The vacation status.
 *
 * Vacation was this app's only status for eight releases, and it is the one that
 * every existing Flow, device and settings page already talks to. It is now one
 * StatusStore among several, but it keeps its own class for two reasons: the
 * settings key must not move, and vacation alone can end itself when Homey sees
 * that person come home.
 */
class VacationStore extends StatusStore {

  /**
   * @param {object} opts
   * @param {import('homey').App['homey']} opts.homey
   */
  constructor({ homey }) {
    super({ homey, settingKey: VACATION_SETTING });
  }

  /** Defaults to on, so a fresh install behaves as the store description says. */
  isAutoReturnEnabled() {
    return this.homey.settings.get(AUTO_RETURN_SETTING) !== false;
  }

  isOnVacation(userId) {
    return this.has(userId);
  }

}

module.exports = VacationStore;
