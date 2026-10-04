'use strict';

const Homey = require('homey');

class VacationDevice extends Homey.Device {

  async onInit() {
    this.userId = this.getData().id;

    this.registerCapabilityListener('onoff', async (value) => {
      // Write through to the store rather than holding state here. The store
      // emits, the app calls syncFromStore() on every device, and the tile
      // settles on the truth - including when something else changed it.
      const store = await this.getStore();
      if (!store) throw new Error(this.homey.__('error.app_not_ready'));

      await store.set(this.userId, value);
    });

    await this.syncFromStore();
    await this.checkUserStillExists();
  }

  /**
   * Homey can initialise a device before the app's onInit has run, in which case
   * homey.app exists but its vacation store does not yet. Reaching for it
   * directly leaves the tile showing null forever, so wait briefly instead.
   *
   * @returns {Promise<import('../../lib/VacationStore')|null>}
   */
  async getStore(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const store = this.homey.app && this.homey.app.vacation;
      if (store) return store;

      await new Promise((resolve) => this.homey.setTimeout(resolve, 100));
    }

    return null;
  }

  /**
   * Pulls the current vacation status onto the tile. Guarded by a comparison so
   * writing through the capability listener cannot bounce back into a loop.
   */
  async syncFromStore() {
    try {
      const store = await this.getStore();
      if (!store) {
        this.error('The app did not become ready; the vacation tile may be out of date.');
        return;
      }

      const onVacation = store.isOnVacation(this.userId);

      if (this.getCapabilityValue('onoff') !== onVacation) {
        await this.setCapabilityValue('onoff', onVacation);
      }
    } catch (err) {
      this.error(`Could not sync vacation status: ${err.message}`);
    }
  }

  /**
   * A device whose Homey user has been deleted would otherwise sit there looking
   * functional while controlling nothing. Say so instead.
   */
  async checkUserStillExists() {
    try {
      const users = await this.homey.app.userStatus.fetchUsers();

      if (users.some((user) => user.id === this.userId)) {
        await this.setAvailable();
      } else {
        await this.setUnavailable(this.homey.__('device.user_gone'));
      }
    } catch (err) {
      // A Homey that cannot be read right now is not evidence the user is gone.
      this.log(`Could not verify the linked user: ${err.message}`);
    }
  }

}

module.exports = VacationDevice;
