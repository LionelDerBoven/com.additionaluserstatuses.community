'use strict';

module.exports = {
  // One round trip for the settings page: every Homey user with a counted flag,
  // plus what the two condition cards would answer right now.
  async getUsers({ homey }) {
    return homey.app.getOverview();
  },
};
