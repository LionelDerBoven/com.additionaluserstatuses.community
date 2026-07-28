'use strict';

module.exports = {
  // One round trip for the settings page: every Homey user with their counted,
  // excluded and vacation flags, plus what the condition cards would answer now.
  async getUsers({ homey }) {
    return homey.app.getOverview();
  },

  // Vacation changes go through the app rather than straight to settings, so the
  // store emits and the Flow triggers and device tiles follow.
  async setVacation({ homey, body }) {
    return homey.app.setVacation(body?.userId, body?.onVacation);
  },
};
