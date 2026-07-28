'use strict';

const Homey = require('homey');

/**
 * One device per Homey user, carrying that user's vacation toggle.
 *
 * The device is a view onto VacationStore, never a second copy of the state.
 * That is what lets a Flow, the settings page, this tile and auto-return all
 * change vacation without any of them drifting out of step.
 */
class VacationDriver extends Homey.Driver {

  /**
   * Offers the live Homey user list during pairing. Homey hides users that are
   * already paired, so this needs no bookkeeping of its own.
   */
  async onPairListDevices() {
    const users = await this.homey.app.userStatus.getEligibleUsers();

    return users
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((user) => ({
        name: user.name,
        data: { id: user.id },
      }));
  }

}

module.exports = VacationDriver;
