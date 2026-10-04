'use strict';

// The last overview we rendered. Save reads the tick boxes against this list, so
// a user deleted in Homey since the page loaded simply drops out on the next load.
let currentUsers = [];

/**
 * Translate through Homey, falling back to the English text if the settings
 * context does not expose __(). The fallback means a missing i18n API degrades
 * to readable English rather than printing raw keys at the user.
 */
function t(key, fallback, tokens) {
  try {
    const out = Homey.__(`ui.${key}`, tokens || {});
    if (out && out !== `ui.${key}`) return out;
  } catch (err) {
    // fall through
  }

  if (!tokens) return fallback;
  return Object.keys(tokens).reduce((acc, k) => acc.split(`__${k}__`).join(tokens[k]), fallback);
}

function badge(text, extraClass) {
  const span = document.createElement('span');
  span.className = extraClass ? `badge ${extraClass}` : 'badge';
  span.textContent = text;
  return span;
}

function showError(message) {
  const el = document.getElementById('error');
  el.textContent = t('read_failed', 'Could not read the Homey users: __message__', { message });
  el.style.display = 'block';
}

/**
 * For a save, a switch or a clear. showError() says the Homey users could not be
 * read, which is a misleading thing to read after ticking a box that failed to
 * save.
 */
function showActionError(message) {
  const el = document.getElementById('error');
  el.textContent = t('action_failed', 'Something went wrong: __message__', { message });
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('error').style.display = 'none';
}

function setVerdict(id, value) {
  const el = document.getElementById(id);
  el.textContent = value ? t('yes', 'Yes') : t('no', 'No');
  el.className = value ? 'verdict-true' : 'verdict-false';
}

function renderVerdicts(overview) {
  setVerdict('verdict-home', overview.everyoneHome);
  setVerdict('verdict-asleep', overview.everyoneAsleep);
  setVerdict('verdict-home-asleep', overview.everyoneHomeAsleep);
  setVerdict('verdict-one-awake', overview.oneHomeAwake);

  document.getElementById('vacation-auto-return').checked = overview.autoReturnEnabled;

  const line = document.getElementById('counted-line');
  if (overview.countedCount === 0) {
    line.textContent = t('none_counted', 'No users are counted, so the "everyone" cards are false. Tick at least one user below.');
  } else {
    line.textContent = t('counting', 'Counting __n__ of __total__ Homey user(s).', {
      n: overview.countedCount, total: overview.users.length,
    });
  }
}

function apply(overview) {
  hideError();
  currentUsers = overview.users;
  renderVerdicts(overview);
  renderUsers(overview.users);
}

/**
 * Vacation writes go through the app's own endpoint rather than Homey.set, so the
 * Flow triggers fire and any paired vacation device follows.
 */
function setVacation(userId, onVacation) {
  Homey.api('POST', '/vacation', { userId, onVacation }, (err, overview) => {
    if (err) {
      showActionError(err.message || String(err));
      return;
    }
    apply(overview);
  });
}

function renderUsers(users) {
  const list = document.getElementById('users');
  list.textContent = '';

  users.forEach((user) => {
    const li = document.createElement('li');
    if (!user.enabled) li.className = 'is-disabled';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.id = `user-${user.id}`;
    box.checked = !user.excluded;
    // A disabled Homey account can never come home or fall asleep, so counting
    // one would pin the cards to false forever. Not the user's choice to make.
    box.disabled = !user.enabled;
    li.appendChild(box);

    const main = document.createElement('div');
    main.className = 'user-main';

    const name = document.createElement('div');
    name.className = 'user-name';
    name.textContent = user.name;
    // Homey returns the role in English. Fall back to printing it raw, so a
    // role added by Homey in future shows something rather than an empty badge.
    name.appendChild(badge(t(`role_${user.role}`, user.role)));
    if (!user.enabled) name.appendChild(badge(t('disabled', 'disabled in Homey')));
    if (user.onVacation) name.appendChild(badge(t('on_vacation', 'on vacation'), 'vacation'));
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'user-meta';
    meta.appendChild(badge(user.present ? t('home', 'home') : t('away', 'away'), user.present ? 'home' : ''));
    meta.appendChild(badge(user.asleep ? t('asleep', 'asleep') : t('awake', 'awake'), user.asleep ? 'asleep' : ''));
    // Worth calling out: this is the usual reason an 'everyone' card is
    // unexpectedly false. Homey has simply never been told about this user.
    if (!user.presenceKnown) meta.appendChild(badge(t('presence_unset', 'presence never set'), 'unknown'));
    if (!user.sleepKnown) meta.appendChild(badge(t('sleep_unset', 'sleep never set'), 'unknown'));
    main.appendChild(meta);

    li.appendChild(main);

    // Vacation applies immediately rather than waiting for Save, because it also
    // fires Flow triggers - deferring that would make the triggers feel arbitrary.
    const vacationLabel = document.createElement('label');
    vacationLabel.className = 'vacation-toggle';
    const vacationBox = document.createElement('input');
    vacationBox.type = 'checkbox';
    vacationBox.checked = user.onVacation;
    vacationBox.disabled = !user.enabled;
    vacationBox.addEventListener('change', () => setVacation(user.id, vacationBox.checked));
    vacationLabel.appendChild(vacationBox);
    vacationLabel.appendChild(document.createTextNode(t('on_vacation', 'on vacation')));
    li.appendChild(vacationLabel);

    list.appendChild(li);
  });
}

function load() {
  Homey.api('GET', '/users', null, (err, overview) => {
    if (err) {
      showError(err.message || String(err));
      return;
    }
    apply(overview);
  });
}

function save() {
  // Store the opt-outs rather than the opt-ins, so a user added to Homey later
  // is counted by default instead of silently ignored.
  const excluded = currentUsers
    .filter((user) => user.enabled)
    .filter((user) => {
      const box = document.getElementById(`user-${user.id}`);
      return box && !box.checked;
    })
    .map((user) => user.id);

  const autoReturn = document.getElementById('vacation-auto-return').checked;

  Homey.set('excluded_user_ids', excluded, (err) => {
    if (err) {
      showActionError(err.message || String(err));
      return;
    }

    Homey.set('vacation_auto_return', autoReturn, (autoReturnErr) => {
      if (autoReturnErr) {
        showActionError(autoReturnErr.message || String(autoReturnErr));
        return;
      }

      const note = document.getElementById('saved-note');
      note.style.display = 'inline';
      setTimeout(() => {
        note.style.display = 'none';
      }, 2500);

      load();
    });
  });
}

// ---------------------------------------------------------------------------
// Log tab
// ---------------------------------------------------------------------------

// Remembered from the last fetch, so re-rendering does not need a round trip.
let use24Hour = true;
// The Homey's own timezone, so the log reads in the house's time wherever this
// page happens to be opened. Empty until the first fetch answers, and then the
// browser's own is the best there is.
let logTimeZone = '';
let logEntries = [];
let logFilter = 'all';

function formatTime(ms) {
  const d = new Date(ms);
  // hour12 false gives 24-hour; true gives the locale's 12-hour form.
  const options = { hour12: !use24Hour };

  if (logTimeZone) {
    try {
      return d.toLocaleTimeString([], { ...options, timeZone: logTimeZone });
    } catch (err) {
      // A timezone name this browser does not know throws a RangeError. A time
      // in the wrong zone beats a log that will not render.
    }
  }

  return d.toLocaleTimeString([], options);
}

/** 'special' keeps the moments a Flow could act on, and anything that broke. */
function visibleEntries() {
  if (logFilter !== 'special') return logEntries;
  return logEntries.filter((e) => e.level === 'trigger' || e.level === 'error');
}

function renderLog() {
  const list = document.getElementById('log');
  const entries = visibleEntries();

  const count = document.getElementById('log-count');
  count.textContent = logEntries.length === entries.length
    ? t('shown', '__n__ shown', { n: entries.length })
    : t('shown_of', '__n__ of __total__ shown', { n: entries.length, total: logEntries.length });

  list.textContent = '';

  if (!entries || entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = t('nothing_logged', 'Nothing logged yet.');
    list.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const li = document.createElement('li');
    if (entry.level && entry.level !== 'info') li.className = `level-${entry.level}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    // Time of day only: the date is rarely useful for a log this short-lived.
    time.textContent = formatTime(entry.at);
    li.appendChild(time);

    const msg = document.createElement('span');
    msg.textContent = entry.message;
    li.appendChild(msg);

    list.appendChild(li);
  });
}

function applyLog(payload) {
  hideError();
  use24Hour = payload.use24Hour !== false;
  logTimeZone = typeof payload.timezone === 'string' ? payload.timezone : '';
  logEntries = payload.entries || [];
  document.getElementById('log-24h').checked = use24Hour;
  document.getElementById('log-persist').checked = payload.persist === true;
  renderLog();
}

function setLogFilter(value) {
  logFilter = value;
  renderLog();
  // Remembered so the choice survives closing the settings page.
  Homey.set('log_filter', value, () => {});
}

function loadLog() {
  Homey.api('GET', '/log', null, (err, payload) => {
    if (err) {
      showError(err.message || String(err));
      return;
    }
    applyLog(payload);
  });
}

function clearLog() {
  Homey.api('POST', '/log/clear', null, (err, payload) => {
    if (err) {
      showActionError(err.message || String(err));
      return;
    }
    applyLog(payload);
  });
}

// Both apply at once rather than waiting for Save: they are view preferences,
// and the app reacts to the persistence one the moment it changes.
function setLogPersist(value) {
  Homey.set('log_persist', value, (err) => {
    if (err) showActionError(err.message || String(err));
  });
}

function setLog24Hour(value) {
  use24Hour = value;
  Homey.set('log_24h', value, (err) => {
    if (err) showActionError(err.message || String(err));
    else loadLog();
  });
}

// ---------------------------------------------------------------------------
// Statuses tab
// ---------------------------------------------------------------------------

let statusData = { statuses: [], users: [] };

// What the app will accept, as it reports them with the statuses. These
// defaults only matter for the instant before the first answer arrives.
const DEFAULT_LIMITS = { maxStatuses: 20, maxNameLength: 64 };

function statusLimits() {
  return { ...DEFAULT_LIMITS, ...(statusData.limits || {}) };
}

function ownStatusCount() {
  return statusData.statuses.filter((status) => !status.builtin).length;
}

function loadStatuses() {
  Homey.api('GET', '/statuses', null, (err, result) => {
    if (err) {
      showError(err.message || String(err));
      return;
    }
    statusData = result;
    renderStatuses();
  });
}

/**
 * One card per status. The built-in two show who holds them and nothing else to
 * edit; a custom one is editable in place, because a status is three fields and
 * a separate edit screen for three fields is worse than the fields themselves.
 */
function renderStatuses() {
  const root = document.getElementById('statuses');
  root.textContent = '';

  for (const status of statusData.statuses) {
    root.appendChild(statusCard(status));
  }

  if (ownStatusCount() === 0) {
    const empty = document.createElement('p');
    empty.className = 'status-holders';
    empty.textContent = t('status_none', 'No statuses of your own yet.');
    root.appendChild(empty);
  }

  // Saying no here beats letting the click through to an error from the app.
  const { maxStatuses } = statusLimits();
  const full = ownStatusCount() >= maxStatuses;
  document.getElementById('status-add').disabled = full;

  if (full) {
    const note = document.createElement('p');
    note.className = 'status-holders';
    note.textContent = t('status_limit', 'Limit reached: you can have at most __max__ statuses of your own.', {
      max: maxStatuses,
    });
    root.appendChild(note);
  }
}

function statusCard(status) {
  const card = document.createElement('div');
  card.className = 'status-card';

  const heading = document.createElement('h3');
  if (status.builtin) {
    heading.textContent = `${status.name} `;
    const note = document.createElement('span');
    note.className = 'builtin';
    note.textContent = `— ${t('status_builtin', 'Comes with the app')}`;
    heading.appendChild(note);
    card.appendChild(heading);
  } else {
    const name = document.createElement('input');
    name.type = 'text';
    name.className = 'status-name-input';
    name.maxLength = statusLimits().maxNameLength;
    name.value = status.name;
    name.placeholder = t('status_name_placeholder', 'Working from home');
    name.addEventListener('change', () => {
      status.name = name.value;
      saveStatuses();
    });
    card.appendChild(name);
  }

  // Vacation's own flags live on the Settings tab, where they always have.
  if (!status.builtin) {
    card.appendChild(flagRow(status, 'excludeFromEveryone', 'status_exclude',
      'Leave holders out of the "everyone" cards'));
    card.appendChild(flagRow(status, 'autoReturn', 'status_auto_return',
      'Clear it automatically when that person comes home'));
  }

  const holders = document.createElement('p');
  holders.className = 'status-holders';
  holders.textContent = t('status_holders', 'Who has it');
  card.appendChild(holders);

  for (const user of statusData.users) {
    if (!user.enabled) continue;
    card.appendChild(holderRow(status, user));
  }

  if (!status.builtin) {
    const remove = document.createElement('button');
    remove.className = 'btn-refresh';
    remove.textContent = t('status_delete', 'Delete');
    remove.addEventListener('click', () => {
      statusData.statuses = statusData.statuses.filter((entry) => entry.id !== status.id);
      saveStatuses();
    });
    card.appendChild(remove);
  }

  return card;
}

function flagRow(status, field, key, fallback) {
  const row = document.createElement('label');
  row.className = 'feature-row';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = status[field] === true;
  box.addEventListener('change', () => {
    status[field] = box.checked;
    saveStatuses();
  });

  const text = document.createElement('span');
  text.textContent = t(key, fallback);

  row.appendChild(box);
  row.appendChild(text);
  return row;
}

function holderRow(status, user) {
  const row = document.createElement('label');
  row.className = 'feature-row';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = (status.userIds || []).includes(user.id);
  box.addEventListener('change', () => {
    Homey.api('POST', '/status', { statusId: status.id, userId: user.id, held: box.checked },
      (err, result) => {
        if (err) {
          box.checked = !box.checked;
          showActionError(err.message || String(err));
          return;
        }
        statusData = result;
        renderStatuses();
      });
  });

  const text = document.createElement('span');
  text.textContent = user.name;

  row.appendChild(box);
  row.appendChild(text);
  return row;
}

function addStatus() {
  if (ownStatusCount() >= statusLimits().maxStatuses) return;

  // The id is what the settings key is built from and can never change, so it is
  // derived once from the name and then left alone however the name is edited.
  const taken = new Set(statusData.statuses.map((status) => status.id));
  let id = 'status1';
  for (let n = 1; taken.has(id); n += 1) id = `status${n}`;

  statusData.statuses.push({
    id, name: t('status_name_placeholder', 'Working from home'), builtin: false, userIds: [],
  });

  saveStatuses();
}

function saveStatuses() {
  const custom = statusData.statuses
    .filter((status) => !status.builtin)
    .map((status) => ({
      id: status.id,
      name: status.name,
      excludeFromEveryone: status.excludeFromEveryone === true,
      autoReturn: status.autoReturn === true,
    }));

  Homey.api('POST', '/statuses', { statuses: custom }, (err, result) => {
    if (err) {
      showActionError(err.message || String(err));
      return;
    }
    statusData = result;
    renderStatuses();
  });
}

function showTab(which) {
  for (const name of ['settings', 'statuses', 'log']) {
    const on = name === which;
    document.getElementById(`tab-${name}`).className = on ? 'tab-pane active' : 'tab-pane';
    document.getElementById(`tab-btn-${name}`).className = on ? 'tab-btn active' : 'tab-btn';
  }

  // Fetched on demand rather than polled, so an open settings page costs nothing.
  if (which === 'log') loadLog();
  if (which === 'statuses') loadStatuses();
}

function onHomeyReady(homey) {
  homey.ready();

  document.getElementById('save').addEventListener('click', save);
  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('log-refresh').addEventListener('click', loadLog);
  document.getElementById('log-clear').addEventListener('click', clearLog);
  document.getElementById('log-persist').addEventListener('change', (e) => setLogPersist(e.target.checked));
  document.getElementById('log-24h').addEventListener('change', (e) => setLog24Hour(e.target.checked));
  document.getElementById('log-filter').addEventListener('change', (e) => setLogFilter(e.target.value));

  Homey.get('log_filter', (err, stored) => {
    if (!err && stored) {
      logFilter = stored;
      document.getElementById('log-filter').value = stored;
    }
  });
  document.getElementById('tab-btn-settings').addEventListener('click', () => showTab('settings'));
  document.getElementById('tab-btn-statuses').addEventListener('click', () => showTab('statuses'));
  document.getElementById('tab-btn-log').addEventListener('click', () => showTab('log'));
  document.getElementById('status-refresh').addEventListener('click', loadStatuses);
  document.getElementById('status-add').addEventListener('click', addStatus);

  load();
}
