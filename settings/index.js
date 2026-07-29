'use strict';

// The last overview we rendered. Save reads the tick boxes against this list, so
// a user deleted in Homey since the page loaded simply drops out on the next load.
let currentUsers = [];

function badge(text, extraClass) {
  const span = document.createElement('span');
  span.className = extraClass ? `badge ${extraClass}` : 'badge';
  span.textContent = text;
  return span;
}

function showError(message) {
  const el = document.getElementById('error');
  el.textContent = `Could not read the Homey users: ${message}`;
  el.style.display = 'block';
}

function hideError() {
  document.getElementById('error').style.display = 'none';
}

function setVerdict(id, value) {
  const el = document.getElementById(id);
  el.textContent = value ? 'Yes' : 'No';
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
    line.textContent = 'No users are counted, so the "everyone" cards are false. Tick at least one user below.';
  } else {
    line.textContent = `Counting ${overview.countedCount} of ${overview.users.length} Homey user(s).`;
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
      showError(err.message || String(err));
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
    name.appendChild(badge(user.role));
    if (!user.enabled) name.appendChild(badge('disabled in Homey'));
    if (user.onVacation) name.appendChild(badge('on vacation', 'vacation'));
    main.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'user-meta';
    meta.appendChild(badge(user.present ? 'home' : 'away', user.present ? 'home' : ''));
    meta.appendChild(badge(user.asleep ? 'asleep' : 'awake', user.asleep ? 'asleep' : ''));
    // Worth calling out: this is the usual reason an 'everyone' card is
    // unexpectedly false. Homey has simply never been told about this user.
    if (!user.presenceKnown) meta.appendChild(badge('presence never set', 'unknown'));
    if (!user.sleepKnown) meta.appendChild(badge('sleep never set', 'unknown'));
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
    vacationLabel.appendChild(document.createTextNode('on vacation'));
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
      showError(err.message || String(err));
      return;
    }

    Homey.set('vacation_auto_return', autoReturn, () => {
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

function renderLog(entries) {
  const list = document.getElementById('log');
  list.textContent = '';

  if (!entries || entries.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'log-empty';
    empty.textContent = 'Nothing logged yet.';
    list.appendChild(empty);
    return;
  }

  entries.forEach((entry) => {
    const li = document.createElement('li');
    if (entry.level && entry.level !== 'info') li.className = `level-${entry.level}`;

    const time = document.createElement('span');
    time.className = 'log-time';
    // Local time only: the date is rarely useful for a log this short-lived.
    time.textContent = new Date(entry.at).toLocaleTimeString();
    li.appendChild(time);

    const msg = document.createElement('span');
    msg.textContent = entry.message;
    li.appendChild(msg);

    list.appendChild(li);
  });
}

function loadLog() {
  Homey.api('GET', '/log', null, (err, entries) => {
    if (err) {
      showError(err.message || String(err));
      return;
    }
    hideError();
    renderLog(entries);
  });
}

function clearLog() {
  Homey.api('POST', '/log/clear', null, (err, entries) => {
    if (err) {
      showError(err.message || String(err));
      return;
    }
    hideError();
    renderLog(entries);
  });
}

function showTab(which) {
  const isLog = which === 'log';
  document.getElementById('tab-settings').className = isLog ? 'tab-pane' : 'tab-pane active';
  document.getElementById('tab-log').className = isLog ? 'tab-pane active' : 'tab-pane';
  document.getElementById('tab-btn-settings').className = isLog ? 'tab-btn' : 'tab-btn active';
  document.getElementById('tab-btn-log').className = isLog ? 'tab-btn active' : 'tab-btn';

  // Fetched on demand rather than polled, so an open settings page costs nothing.
  if (isLog) loadLog();
}

function onHomeyReady(homey) {
  homey.ready();

  document.getElementById('save').addEventListener('click', save);
  document.getElementById('refresh').addEventListener('click', load);
  document.getElementById('log-refresh').addEventListener('click', loadLog);
  document.getElementById('log-clear').addEventListener('click', clearLog);
  document.getElementById('tab-btn-settings').addEventListener('click', () => showTab('settings'));
  document.getElementById('tab-btn-log').addEventListener('click', () => showTab('log'));

  load();
}
