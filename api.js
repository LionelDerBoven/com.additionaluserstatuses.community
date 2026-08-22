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

  async getLog({ homey }) {
    return homey.app.getLog();
  },

  async clearLog({ homey }) {
    return homey.app.clearLog();
  },

  // Statuses beyond vacation: the list itself, and who holds each one.
  async getStatuses({ homey }) {
    return homey.app.getStatuses();
  },

  async setStatus({ homey, body }) {
    return homey.app.setStatus(body?.statusId, body?.userId, body?.held);
  },

  // The page edits the whole list of custom statuses at once, so this replaces
  // it rather than adding one - that is what makes deleting one possible.
  async saveStatuses({ homey, body }) {
    return homey.app.saveStatuses(body?.statuses);
  },
};
