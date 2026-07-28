'use strict';

const Homey = require('homey');

class VacationDevice extends Homey.Device {

  async onInit() {
    this.userId = this.getData().id;

    this.registerCapabilityListener('onoff', async (value) => {
      // Write through to the store rather than holding state here. The store
      // emits, the app calls syncFromStore() on every device, and the tile
      // settles on the truth - including when something else changed it.
      await this.homey.app.vacation.set(this.userId, value);
    });

    await this.syncFromStore();
    await this.checkUserStillExists();
  }

  /**
   * Pulls the current vacation status onto the tile. Guarded by a comparison so
   * writing through the capability listener cannot bounce back into a loop.
   */
  async syncFromStore() {
    try {
      const onVacation = this.homey.app.vacation.isOnVacation(this.userId);

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
