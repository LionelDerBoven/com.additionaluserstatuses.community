'use strict';

const Homey = require('homey');

class StatusDevice extends Homey.Device {

  async onInit() {
    const data = this.getData();
    this.statusId = data.statusId;
    this.userId = data.userId;

    this.registerCapabilityListener('onoff', async (value) => {
      // Write through to the store rather than holding state here. The store
      // emits, the app calls syncFromStore() on every device, and the tile
      // settles on the truth - including when something else changed it.
      const store = await this.getStore();
      if (!store) throw new Error(this.homey.__('error.app_not_ready'));

      await store.set(this.userId, value);
    });

    await this.syncFromStore();
    await this.checkStillValid();
  }

  /**
   * Homey can initialise a device before the app's onInit has run, in which case
   * homey.app exists but its status registry does not yet. Reaching for it
   * directly leaves the tile showing null forever, so wait briefly instead.
   *
   * Null means the app never became ready. A registry that is there but no
   * longer knows this device's status is a different thing - the user deleted it
   * - and says so, rather than passing for a slow start.
   *
   * @returns {Promise<import('../../lib/StatusStore')|null>}
   */
  async getStore(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const registry = this.homey.app && this.homey.app.statuses;
      if (registry) {
        const store = registry.store(this.statusId);
        if (!store) throw new Error(this.homey.__('device.status_gone'));

        return store;
      }

      await new Promise((resolve) => this.homey.setTimeout(resolve, 100));
    }

    return null;
  }

  /**
   * Pulls the current status onto the tile. Guarded by a comparison so writing
   * through the capability listener cannot bounce back into a loop.
   */
  async syncFromStore() {
    try {
      const store = await this.getStore();
      if (!store) {
        this.error('The app did not become ready; the status tile may be out of date.');
        return;
      }

      const held = store.has(this.userId);

      if (this.getCapabilityValue('onoff') !== held) {
        await this.setCapabilityValue('onoff', held);
      }
    } catch (err) {
      this.error(`Could not sync the status: ${err.message}`);
    }
  }

  /**
   * A device whose user was deleted, or whose status the user has since removed,
   * would otherwise sit there looking functional while controlling nothing.
   */
  async checkStillValid() {
    try {
      const users = await this.homey.app.userStatus.fetchUsers();
      const status = this.homey.app.statuses.get(this.statusId);

      if (!status) {
        await this.setUnavailable(this.homey.__('device.status_gone'));
      } else if (!users.some((user) => user.id === this.userId)) {
        await this.setUnavailable(this.homey.__('device.user_gone'));
      } else {
        await this.setAvailable();
      }
    } catch (err) {
      // A Homey that cannot be read right now is not evidence anything is gone.
      this.log(`Could not verify the linked user or status: ${err.message}`);
    }
  }

}

module.exports = StatusDevice;
