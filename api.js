'use strict';

// A Homey user id is a UUID. These endpoints are reachable by any Homey user of
// this Homey, of any role, and whatever they pass ends up in a Set that is
// written to app settings - where a read-side filter makes a wrong-typed id
// inert but does not stop it being stored. Refuse it at the door instead.
//
// The door has two halves. This file refuses an id of the wrong shape, which
// needs no Homey to answer. Whether the id belongs to a user that exists needs
// the live user list, so app.setVacation() and app.setStatus() check that.
const MAX_ID_LENGTH = 64;

/**
 * @param {import('homey').App['homey']} homey Only for the translated error.
 * @param {unknown} value
 * @returns {string}
 */
function userId(homey, value) {
  if (typeof value !== 'string' || !value || value.length > MAX_ID_LENGTH) {
    throw new Error(homey.__('error.invalid_request'));
  }

  return value;
}

module.exports = {
  // One round trip for the settings page: every Homey user with their counted,
  // excluded and vacation flags, plus what the condition cards would answer now.
  async getUsers({ homey }) {
    return homey.app.getOverview();
  },

  // Vacation changes go through the app rather than straight to settings, so the
  // store emits and the Flow triggers and device tiles follow.
  async setVacation({ homey, body }) {
    return homey.app.setVacation(userId(homey, body?.userId), body?.onVacation === true);
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
    return homey.app.setStatus(body?.statusId, userId(homey, body?.userId), body?.held === true);
  },

  // The page edits the whole list of custom statuses at once, so this replaces
  // it rather than adding one - that is what makes deleting one possible.
  async saveStatuses({ homey, body }) {
    return homey.app.saveStatuses(body?.statuses);
  },
};
