'use strict';

const Homey = require('homey');

/**
 * One device per user and status, carrying that pair's toggle.
 *
 * The device is a view onto the status store, never a second copy of the state.
 * That is what lets a Flow, the settings page, this tile and auto-return all
 * change a status without any of them drifting out of step.
 *
 * The vacation driver stays alongside this one: it has paired devices in the
 * field, and moving them would break the Flows they sit in for no gain.
 */
class StatusDriver extends Homey.Driver {

  /**
   * Every user crossed with every status, minus the pairs already added. Homey
   * hides a device whose data matches one that exists, so this needs no
   * bookkeeping of its own.
   */
  async onPairListDevices() {
    const users = await this.homey.app.userStatus.getEligibleUsers();
    const statuses = this.homey.app.statuses.list();

    const devices = [];

    for (const status of statuses) {
      for (const user of users) {
        devices.push({
          // Status first: the tiles for one status then sort together, and a
          // narrow tile truncating the label still says which status it is.
          name: `${status.name} ${user.name}`,
          data: { id: `${status.id}:${user.id}`, statusId: status.id, userId: user.id },
        });
      }
    }

    return devices.sort((a, b) => a.name.localeCompare(b.name));
  }

}

module.exports = StatusDriver;
