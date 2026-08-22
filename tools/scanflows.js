/**
 * Which Flows depend on this app, and is anything unresolved?
 *
 * Run this inside Homey - HomeyScript, or the homeyscript_run MCP tool - before
 * and after every release that touches Flow cards. The point is the diff: a card
 * this app renames or removes takes a real automation down with it, and the only
 * way to know which is to have measured before.
 *
 * Not a Node script: the global `Homey` here is the Homey Web API client that
 * HomeyScript provides, so `npm test` never sees this file.
 */

const APP_ID = 'com.additionaluserstatuses.community';

/** Card ids of this app referenced anywhere in a Flow, however deeply nested. */
function cardsUsedIn(flow) {
  const json = JSON.stringify(flow);
  if (!json.includes(APP_ID)) return [];

  const pattern = new RegExp(`${APP_ID.replace(/\./g, '\\.')}:([a-z_]+)`, 'g');
  return [...new Set((json.match(pattern) || []).map((hit) => hit.split(':').pop()))].sort();
}

const flows = [
  ...Object.values(await Homey.flow.getFlows()).map((flow) => ({ kind: 'basic', flow })),
  ...Object.values(await Homey.flow.getAdvancedFlows()).map((flow) => ({ kind: 'advanced', flow })),
];

const users = [];
const perCard = {};

for (const { kind, flow } of flows) {
  const cards = cardsUsedIn(flow);
  if (cards.length === 0) continue;

  users.push({ kind, name: flow.name, enabled: flow.enabled, cards });
  for (const card of cards) perCard[card] = (perCard[card] || 0) + 1;
}

// Every card the app ships, so the report also names the ones nobody uses -
// those are the ones that can be changed freely.
const app = await Homey.apps.getApp({ id: APP_ID });

return {
  scannedFlows: flows.length,
  flowsUsingThisApp: users.length,
  perCard: Object.fromEntries(Object.entries(perCard).sort((a, b) => b[1] - a[1])),
  flows: users.sort((a, b) => b.cards.length - a.cards.length),
  appVersion: app.version,
};
