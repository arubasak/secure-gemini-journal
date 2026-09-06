import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  signOut,
} from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';

/* =========================================================================
   State & tiny DOM helpers. All user/AI text is inserted with textContent,
   never innerHTML, so nothing from Firestore or Gemini can execute in the page.
   ========================================================================= */
const state = { user: null, profile: null, features: {}, entries: [], view: 'journal', currentId: null, insights: null };
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

const MOOD_EMOJI = { joyful: '😄', content: '🙂', calm: '😌', neutral: '😐', tired: '😴', anxious: '😰', stressed: '😣', sad: '😢', angry: '😠' };
const fmtDate = (iso, opts = { dateStyle: 'medium', timeStyle: 'short' }) => (iso ? new Intl.DateTimeFormat(undefined, opts).format(new Date(iso)) : '');

let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast${isError ? ' err' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3500);
}

/** Minimal, safe Markdown: paragraphs, "- " bullets, **bold**, *italic*. Builds DOM nodes only. */
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || '').split(/\r?\n/);
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) frag.append(h('p', {}, ...inline(para.join(' '))));
    para = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    const bullet = /^[-*•]\s+(.*)/.exec(line);
    if (bullet) {
      flushPara();
      if (!list) { list = h('ul'); frag.append(list); }
      list.append(h('li', {}, ...inline(bullet[1])));
      continue;
    }
    list = null;
    if (!line) { flushPara(); continue; }
    para.push(line);
  }
  flushPara();
  return frag;
}
function inline(text) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(h('strong', { text: tok.slice(2, -2) }));
    else out.push(h('em', { text: tok.slice(1, -1) }));
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/* =========================================================================
   API client - every call carries a fresh Firebase ID token.
   ========================================================================= */
async function api(path, { method = 'GET', body } = {}) {
  if (!state.user) throw new Error('Not signed in');
  const token = await state.user.getIdToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Server-Sent Events reader for streaming Gemini replies. Resolves with the `done` payload. */
async function streamReply(entryId, message, onPartial) {
  const token = await state.user.getIdToken();
  const res = await fetch(`/api/entries/${entryId}/messages/stream`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; throw err;
  }
  if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) { const e = new Error('Streaming unavailable'); e.status = 0; throw e; }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let partial = ''; let done = null;
  const handle = (block) => {
    let event = 'message'; const dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const payload = JSON.parse(dataLines.join('\n'));
    if (event === 'chunk') { partial += payload.text; onPartial(partial); }
    else if (event === 'done') done = payload;
    else if (event === 'error') { const e = new Error(payload.error); e.status = 500; throw e; }
  };
  for (;;) {
    const { value, done: eof } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) { handle(buffer.slice(0, idx)); buffer = buffer.slice(idx + 2); }
  }
  if (buffer.trim()) handle(buffer);
  if (!done) { const e = new Error('The reply was cut off. Please try again.'); e.status = 500; throw e; }
  return done;
}

/* =========================================================================
   Auth
   ========================================================================= */
let auth;
const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Email or password is incorrect.',
  'auth/wrong-password': 'Email or password is incorrect.',
  'auth/user-not-found': 'No account with that email. Try "Create account".',
  'auth/email-already-in-use': 'That email already has an account. Try signing in.',
  'auth/weak-password': 'Please use a password with at least 8 characters.',
  'auth/invalid-email': 'That email address does not look right.',
  'auth/popup-closed-by-user': 'Sign-in window was closed before finishing.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/unauthorized-domain': 'This domain is not authorised in Firebase Authentication settings.',
};
const authError = (err) => AUTH_MESSAGES[err?.code] || err?.message || 'Something went wrong. Please try again.';

function wireAuthUI() {
  const errEl = $('#auth-error');
  const setErr = (m) => (errEl.textContent = m || '');
  const busy = (on) => $$('#auth-screen button').forEach((b) => (b.disabled = on));

  $('#google-signin').addEventListener('click', async () => {
    setErr(''); busy(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (err) { setErr(authError(err)); } finally { busy(false); }
  });

  $('#email-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setErr('');
    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (!email || password.length < 8) return setErr('Enter your email and a password of at least 8 characters.');
    busy(true);
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch (err) { setErr(authError(err)); } finally { busy(false); }
  });

  $('#email-signup').addEventListener('click', async () => {
    setErr('');
    const email = $('#email').value.trim();
    const password = $('#password').value;
    if (!email || password.length < 8) return setErr('Enter your email and choose a password of at least 8 characters.');
    busy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      sendEmailVerification(cred.user).catch(() => {});
      toast('Account created. We sent you a verification email.');
    } catch (err) { setErr(authError(err)); } finally { busy(false); }
  });

  $('#forgot').addEventListener('click', async () => {
    setErr('');
    const email = $('#email').value.trim();
    if (!email) return setErr('Enter your email above first, then click "Forgot your password?".');
    try { await sendPasswordResetEmail(auth, email); toast('Password reset email sent.'); }
    catch (err) { setErr(authError(err)); }
  });

  $('#signout').addEventListener('click', () => signOut(auth));
}
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* =========================================================================
   Boot & routing
   ========================================================================= */
async function boot() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Server configuration unavailable');
    const cfg = await res.json();
    state.features = cfg.features || {};
    auth = getAuth(initializeApp(cfg.firebase));
  } catch (err) {
    $('#loading').replaceChildren(h('p', { class: 'error', text: `Could not start the app: ${err.message}` }));
    return;
  }
  wireAuthUI();
  window.addEventListener('hashchange', route);

  onAuthStateChanged(auth, async (user) => {
    state.user = user;
    $('#loading').hidden = true;
    if (!user) {
      state.profile = null; state.entries = []; state.insights = null;
      $('#shell').hidden = true;
      $('#auth-screen').hidden = false;
      return;
    }
    $('#auth-screen').hidden = true;
    $('#shell').hidden = false;
    $('#user-name').textContent = user.displayName || user.email || '';
    const avatar = $('#avatar');
    if (user.photoURL) { avatar.src = user.photoURL; avatar.hidden = false; } else avatar.hidden = true;
    try {
      state.profile = await api('/account/me');
      $('#tab-admin').hidden = !state.profile.admin;
      await loadEntries();
    } catch (err) {
      toast(err.message, true);
    }
    route();
  });
}

function route() {
  if (!state.user) return;
  const hash = location.hash || '#/journal';
  const [, seg, id] = hash.split('/');
  const view = ['journal', 'insights', 'ask', 'account', 'admin', 'new', 'entry'].includes(seg) ? seg : 'journal';
  const tab = view === 'new' || view === 'entry' ? 'journal' : view;
  if (tab === 'admin' && !state.profile?.admin) { location.hash = '#/journal'; return; }

  $$('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  for (const v of ['journal', 'insights', 'ask', 'account', 'admin']) $(`#view-${v}`).hidden = v !== tab;

  if (tab === 'journal') {
    state.currentId = view === 'entry' ? id : null;
    $('#view-journal').classList.toggle('has-selection', view === 'entry' || view === 'new');
    renderEntryList();
    if (view === 'new') renderEditor();
    else if (view === 'entry') openEntry(id);
    else renderEmptyPane();
  } else if (tab === 'insights') renderInsights();
  else if (tab === 'ask') renderAsk();
  else if (tab === 'account') renderAccount();
  else if (tab === 'admin') renderAdmin();
}

/* =========================================================================
   Journal: list
   ========================================================================= */
async function loadEntries() {
  const data = await api('/entries?limit=100');
  state.entries = data.entries;
}

function renderEntryList() {
  const ul = clear($('#entries'));
  if (!state.entries.length) {
    ul.append(h('li', { class: 'empty', text: 'No entries yet. Your first one is a click away.' }));
    return;
  }
  for (const e of state.entries) {
    const mood = e.analysis?.mood;
    ul.append(
      h('li', {},
        h('a', { href: `#/entry/${e.id}`, class: e.id === state.currentId ? 'active' : '' },
          h('div', { class: 'title' }, mood ? h('span', { class: 'mood-emoji', 'aria-label': mood, title: mood, text: MOOD_EMOJI[mood] }) : null, e.title),
          h('div', { class: 'meta' },
            h('span', { text: fmtDate(e.createdAt, { dateStyle: 'medium' }) }),
            e.location?.label ? h('span', { text: `📍 ${e.location.label}` }) : null,
            e.messageCount ? h('span', { text: `💬 ${Math.floor(e.messageCount / 2)}` }) : null),
          h('div', { class: 'preview', text: e.preview })))
    );
  }
}

function renderEmptyPane() {
  const pane = clear($('#entry-pane'));
  pane.append(
    h('div', { class: 'empty-state' },
      h('div', { class: 'big', 'aria-hidden': 'true', text: '✎' }),
      h('h2', { text: state.entries.length ? 'Pick an entry, or start a new one' : 'Welcome to your journal' }),
      h('p', { text: 'Write what is on your mind. Gemini will read it, sense the mood, and reflect with you in a private conversation.' }),
      h('a', { class: 'btn btn-primary', href: '#/new', text: 'Write an entry' }))
  );
}

/* =========================================================================
   Journal: editor (new + edit) with optional location
   ========================================================================= */
function renderEditor(existing = null) {
  const pane = clear($('#entry-pane'));
  let geo = existing?.location ? { ...existing.location } : null;

  const title = h('input', { class: 'title', type: 'text', maxlength: '120', placeholder: 'Title (optional)', 'aria-label': 'Title', value: existing?.title || '' });
  const content = h('textarea', { maxlength: '10000', placeholder: 'What happened today? How did it feel?', 'aria-label': 'Journal entry' });
  content.value = existing?.content || '';
  const counter = h('span', { class: 'muted', text: `${content.value.length} / 10000` });
  content.addEventListener('input', () => (counter.textContent = `${content.value.length} / 10000`));

  const locLabel = h('input', { type: 'text', maxlength: '120', placeholder: 'Name this place (optional)', 'aria-label': 'Place name', hidden: !geo, value: geo?.label || '' });
  const locStatus = h('span', { class: 'muted', text: geo ? `📍 ${geo.lat.toFixed(3)}, ${geo.lng.toFixed(3)}` : '' });
  const locBtn = h('button', { type: 'button', class: 'btn btn-sm', text: geo ? 'Remove location' : '📍 Add location' });
  locBtn.addEventListener('click', () => {
    if (geo) {
      geo = null; locLabel.hidden = true; locLabel.value = ''; locStatus.textContent = ''; locBtn.textContent = '📍 Add location';
      return;
    }
    if (!navigator.geolocation) return toast('Location is not available in this browser.', true);
    locBtn.disabled = true; locStatus.textContent = 'Locating…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        geo = { lat: pos.coords.latitude, lng: pos.coords.longitude, label: '' };
        locStatus.textContent = `📍 ${geo.lat.toFixed(3)}, ${geo.lng.toFixed(3)}`;
        locLabel.hidden = false; locBtn.textContent = 'Remove location'; locBtn.disabled = false;
        if (!state.features.maps) locLabel.placeholder = 'Name this place (e.g. Home, Office)';
      },
      (err) => { locBtn.disabled = false; locStatus.textContent = ''; toast(err.code === 1 ? 'Location permission was denied.' : 'Could not get your location.', true); },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 }
    );
  });

  const save = h('button', { type: 'submit', class: 'btn btn-primary', text: existing ? 'Save changes' : 'Save & analyse' });
  const form = h('form', { class: 'card editor', novalidate: true },
    h('a', { class: 'btn btn-ghost btn-sm back', href: existing ? `#/entry/${existing.id}` : '#/journal', text: '← Back' }),
    h('h2', { text: existing ? 'Edit entry' : 'New entry' }),
    title,
    h('div', { style: 'margin-top:.6rem' }, content),
    h('div', { class: 'row between', style: 'margin-top:.4rem' }, counter,
      h('span', { class: 'muted', text: 'Gemini will tag the mood and themes when you save.' })),
    h('div', { class: 'location-box' },
      voiceButton((text) => { content.value = (content.value.trim() ? content.value.trimEnd() + '\n\n' : '') + text; content.dispatchEvent(new Event('input')); content.focus(); }),
      locBtn, locStatus, locLabel),
    h('div', { class: 'row end', style: 'margin-top:1rem' },
      h('a', { class: 'btn btn-ghost', href: existing ? `#/entry/${existing.id}` : '#/journal', text: 'Cancel' }), save)
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!content.value.trim()) { content.focus(); return toast('Write something first.', true); }
    save.disabled = true; save.textContent = 'Saving…';
    try {
      const body = { title: title.value, content: content.value, location: geo ? { ...geo, label: locLabel.value } : null };
      const data = existing ? await api(`/entries/${existing.id}`, { method: 'PUT', body }) : await api('/entries', { method: 'POST', body });
      await loadEntries();
      toast(existing ? 'Entry updated.' : data.entry.analysis ? `Saved. Mood: ${data.entry.analysis.mood}` : 'Saved.');
      location.hash = `#/entry/${data.entry.id}`;
    } catch (err) {
      toast(err.message, true); save.disabled = false; save.textContent = existing ? 'Save changes' : 'Save & analyse';
    }
  });
  pane.append(form);
  (existing ? content : title).focus();
}

/* =========================================================================
   Journal: entry detail + Gemini reflection thread
   ========================================================================= */
async function openEntry(id) {
  const pane = clear($('#entry-pane'));
  pane.append(h('div', { class: 'center', style: 'padding:3rem' }, h('div', { class: 'spinner' })));
  let data;
  try { data = await api(`/entries/${id}`); }
  catch (err) {
    clear(pane).append(h('div', { class: 'empty-state' }, h('h2', { text: err.status === 404 ? 'Entry not found' : 'Could not load entry' }), h('a', { class: 'btn', href: '#/journal', text: 'Back to journal' })));
    return;
  }
  if (state.currentId !== id) return; // user navigated away meanwhile
  renderEntry(data.entry, data.messages);
}

function renderEntry(entry, messages) {
  const pane = clear($('#entry-pane'));
  const a = entry.analysis;

  const header = h('div', { class: 'card' },
    h('a', { class: 'btn btn-ghost btn-sm back', href: '#/journal', text: '← All entries' }),
    h('div', { class: 'entry-header' },
      h('h1', { text: entry.title }),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-sm', type: 'button', text: 'Edit', onClick: () => renderEditor(entry) }),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: 'Delete', onClick: () => deleteEntry(entry) }))),
    h('div', { class: 'entry-meta' },
      h('span', { text: fmtDate(entry.createdAt) }),
      entry.updatedAt !== entry.createdAt ? h('span', { class: 'muted', text: `edited ${fmtDate(entry.updatedAt)}` }) : null,
      entry.location ? h('a', { class: 'chip', target: '_blank', rel: 'noopener', href: `https://www.google.com/maps?q=${entry.location.lat},${entry.location.lng}`, text: `📍 ${entry.location.label || `${entry.location.lat}, ${entry.location.lng}`}` }) : null,
      a ? h('span', { class: 'chip mood', text: `${MOOD_EMOJI[a.mood] || ''} ${a.mood} · energy ${a.energy}` }) : null),
    h('div', { class: 'entry-content', text: entry.content }),
    entry.location && state.features.maps ? mapImage(entry.id) : null
  );

  const analysis = h('div', { class: 'card analysis' },
    h('h3', { text: 'Mood Compass' }),
    a
      ? [
          h('p', { class: 'summary', text: a.summary }),
          h('div', { class: 'chips' }, ...(a.themes || []).map((t) => h('span', { class: 'chip theme', text: `#${t}` })),
            h('span', { class: 'chip', text: `valence ${a.score > 0 ? '+' : ''}${a.score}` })),
        ]
      : h('div', { class: 'row between' },
          h('span', { class: 'muted', text: 'Not analysed yet (Gemini was unavailable when this was saved).' }),
          h('button', { class: 'btn btn-sm', type: 'button', text: 'Analyse now', onClick: async (ev) => {
            ev.target.disabled = true;
            try { const d = await api(`/entries/${entry.id}/analyze`, { method: 'POST' }); await loadEntries(); renderEntry(d.entry, messages); }
            catch (err) { toast(err.message, true); ev.target.disabled = false; }
          } }))
  );

  // Auto-saved conversation summary (updated after every exchange)
  const summaryText = h('p', { class: 'summary', text: entry.summary?.text || '' });
  const summaryMeta = h('span', { class: 'muted', style: 'font-size:.78rem', text: entry.summary ? `auto-saved · ${fmtDate(entry.summary.updatedAt)}` : '' });
  const summaryCard = h('div', { class: 'card analysis', hidden: !entry.summary },
    h('div', { class: 'row between' }, h('h3', { text: 'Conversation summary' }), summaryMeta), summaryText);
  const showSummary = (s) => {
    if (!s?.text) return;
    entry.summary = s;
    summaryText.textContent = s.text;
    summaryMeta.textContent = `auto-saved · ${fmtDate(s.updatedAt)}`;
    summaryCard.hidden = false;
  };

  const thread = h('div', { class: 'thread', 'aria-live': 'polite', 'aria-label': 'Reflection conversation' });
  const paintMessages = () => {
    clear(thread);
    if (!messages.length) thread.append(h('p', { class: 'muted', text: 'Start a conversation about this entry. Gemini has read it and will respond to what you wrote.' }));
    for (const m of messages) thread.append(messageBubble(m));
  };
  paintMessages();

  const input = h('textarea', { placeholder: 'Ask, vent, or think out loud…', 'aria-label': 'Message to Gemini', maxlength: '2000', rows: '2' });
  const send = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Send' });
  const suggest = a?.prompt && !messages.length
    ? h('div', { class: 'suggest' }, h('button', { class: 'btn btn-sm', type: 'button', text: `💡 ${a.prompt}`, onClick: () => { input.value = a.prompt; input.focus(); } }))
    : null;

  const composer = h('form', { class: 'composer', novalidate: true }, input, send);
  const submit = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; send.disabled = true; input.disabled = true;
    if (suggest) suggest.remove();
    if (!messages.length) clear(thread);
    thread.append(messageBubble({ role: 'user', text }));
    const typing = h('div', { class: 'msg model' }, h('div', { class: 'who', text: 'Gemini' }), h('div', { class: 'typing' }, h('i'), h('i'), h('i')));
    thread.append(typing);
    typing.scrollIntoView({ block: 'end', behavior: 'smooth' });
    try {
      // Stream the reply token by token; fall back to the non-streaming endpoint if SSE is unavailable.
      let d;
      try {
        d = await streamReply(entry.id, text, (partial) => {
          clear(typing).append(h('div', { class: 'who', text: 'Gemini' }), renderMarkdown(partial));
          typing.scrollIntoView({ block: 'end' });
        });
      } catch (streamErr) {
        if (streamErr.status && streamErr.status !== 0) throw streamErr;
        d = await api(`/entries/${entry.id}/messages`, { method: 'POST', body: { message: text } });
      }
      messages.push(...d.messages);
      paintMessages();
      showSummary(d.summary);
      thread.lastElementChild?.scrollIntoView({ block: 'end', behavior: 'smooth' });
      loadEntries().then(renderEntryList).catch(() => {});
    } catch (err) {
      typing.remove();
      input.value = text;
      toast(err.message, true);
    } finally { send.disabled = false; input.disabled = false; input.focus(); }
  };
  composer.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });

  const chat = h('div', { class: 'card' }, h('h3', { text: 'Reflect with Gemini' }), thread, suggest, composer,
    h('p', { class: 'muted', style: 'font-size:.78rem;margin:.6rem 0 0', text: 'Gemini is an AI, not a therapist. If you are in crisis, contact local emergency services or a helpline.' }));

  pane.append(header, analysis, summaryCard, chat);
}

function messageBubble(m) {
  const el = h('div', { class: `msg ${m.role === 'model' ? 'model' : 'user'}` }, h('div', { class: 'who', text: m.role === 'model' ? 'Gemini' : 'You' }));
  if (m.role === 'model') el.append(renderMarkdown(m.text));
  else el.append(document.createTextNode(m.text));
  return el;
}

function mapImage(entryId) {
  const img = h('img', { class: 'map-img', alt: 'Map of where this entry was written', hidden: true });
  state.user.getIdToken().then((token) =>
    fetch(`/api/entries/${entryId}/map.png`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => { if (blob) { img.src = URL.createObjectURL(blob); img.hidden = false; } })
      .catch(() => {})
  );
  return img;
}

async function deleteEntry(entry) {
  const ok = await confirmDialog({ title: 'Delete this entry?', text: `"${entry.title}" and its conversation will be permanently removed.`, okLabel: 'Delete' });
  if (!ok) return;
  try {
    await api(`/entries/${entry.id}`, { method: 'DELETE' });
    await loadEntries();
    toast('Entry deleted.');
    location.hash = '#/journal';
  } catch (err) { toast(err.message, true); }
}

function confirmDialog({ title, text, okLabel = 'Confirm', requireText = null }) {
  const dlg = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const input = $('#confirm-input');
  const ok = $('#confirm-ok');
  ok.textContent = okLabel;
  input.hidden = !requireText;
  input.value = '';
  input.placeholder = requireText || '';
  ok.disabled = Boolean(requireText);
  const onInput = () => (ok.disabled = input.value !== requireText);
  input.addEventListener('input', onInput);
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => { input.removeEventListener('input', onInput); resolve(dlg.returnValue === 'ok'); }, { once: true });
  });
}

/* =========================================================================
   Insights (Mood Compass)
   ========================================================================= */
async function renderInsights() {
  const root = clear($('#insights-root'));
  root.append(h('h1', { text: 'Mood Compass' }), h('p', { class: 'muted', text: 'Patterns across your entries, computed only from your own data. Nothing here is shared.' }));
  let data;
  try { data = state.insights = await api('/insights'); }
  catch (err) { root.append(h('p', { class: 'error', text: err.message })); return; }

  const t = data.totals;
  const avg = t.averageScore === null ? '–' : `${t.averageScore > 0 ? '+' : ''}${t.averageScore}`;
  root.append(h('div', { class: 'stats' },
    stat(t.entries, 'entries'), stat(t.thisWeek, 'this week'), stat(t.streak, `day streak`), stat(avg, 'avg valence (−2…+2)'), stat(Math.floor(t.conversations / 2), 'Gemini replies')));

  if (!data.series.length) {
    root.append(h('div', { class: 'card empty-state' }, h('h2', { text: 'No analysed entries yet' }), h('p', { text: 'Write a few entries and your mood trend, themes and weekly reflection will appear here.' }), h('a', { class: 'btn btn-primary', href: '#/new', text: 'Write an entry' })));
    return;
  }

  root.append(h('div', { class: 'card' }, h('h3', { text: 'Mood over time' }), moodChart(data.series)));

  const moodsTotal = data.moods.reduce((n, m) => n + m.count, 0);
  root.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h3', { text: 'Moods' }), h('div', { class: 'bars' }, ...data.moods.map((m) => bar(`${MOOD_EMOJI[m.name] || ''} ${m.name}`, m.count, moodsTotal)))),
    h('div', { class: 'card' },
      h('h3', { text: 'Recurring themes' }),
      data.themes.length ? h('div', { class: 'chips' }, ...data.themes.map((x) => h('span', { class: 'chip theme', text: `#${x.name} · ${x.count}` }))) : h('p', { class: 'muted', text: 'No themes yet.' }),
      data.places.length ? [h('h3', { style: 'margin-top:1rem', text: 'Places you write from' }), h('div', { class: 'chips' }, ...data.places.map((x) => h('span', { class: 'chip', text: `📍 ${x.name} · ${x.count}` })))] : null)));

  // Weekly reflection
  const body = h('div', { class: 'reflection muted', text: t.thisWeek ? 'Ask Gemini to look back over the last 7 days.' : 'Write an entry this week to unlock your weekly reflection.' });
  const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'button', text: 'Generate', disabled: !t.thisWeek });
  const meta = h('span', { class: 'muted', style: 'font-size:.8rem' });
  const load = async (refresh) => {
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      const d = await api(`/insights/weekly${refresh ? '?refresh=1' : ''}`);
      if (d.reflection) {
        body.className = 'reflection'; clear(body).append(renderMarkdown(d.reflection));
        meta.textContent = `${d.entryCount} entries · ${d.cached ? 'from cache' : 'just generated'} · ${fmtDate(d.generatedAt)}`;
        btn.textContent = 'Regenerate';
      }
    } catch (err) { toast(err.message, true); btn.textContent = 'Generate'; }
    finally { btn.disabled = false; }
  };
  btn.addEventListener('click', () => load(btn.textContent === 'Regenerate'));
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('div', { class: 'row between' }, h('h3', { text: 'Week in review' }), h('div', { class: 'row' }, meta, btn)), body));
  if (t.thisWeek) load(false);
}
const stat = (value, label) => h('div', { class: 'stat' }, h('div', { class: 'value', text: String(value) }), h('div', { class: 'label', text: label }));
const bar = (label, count, total) => h('div', { class: 'bar' }, h('span', { text: label }), h('div', { class: 'track' }, h('div', { class: 'fill', style: `width:${total ? Math.round((count / total) * 100) : 0}%` })), h('span', { class: 'muted', text: String(count) }));

function moodChart(series) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 640, H = 220, padL = 34, padR = 12, padT = 14, padB = 30;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'chart');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Mood valence for the last ${series.length} entries`);
  const el = (tag, attrs, text) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (text !== undefined) n.textContent = text; svg.append(n); return n; };
  const x = (i) => padL + (series.length === 1 ? (W - padL - padR) / 2 : (i * (W - padL - padR)) / (series.length - 1));
  const y = (s) => padT + ((2 - s) * (H - padT - padB)) / 4;
  for (const s of [-2, -1, 0, 1, 2]) {
    el('line', { x1: padL, x2: W - padR, y1: y(s), y2: y(s), class: `grid-line${s === 0 ? ' zero' : ''}` });
    el('text', { x: padL - 8, y: y(s) + 4, 'text-anchor': 'end' }, s > 0 ? `+${s}` : String(s));
  }
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.score).toFixed(1)}`);
  if (series.length > 1) {
    el('path', { class: 'area', d: `M${x(0)},${y(0)} L${pts.join(' L')} L${x(series.length - 1)},${y(0)} Z` });
    el('path', { class: 'line', d: `M${pts.join(' L')}` });
  }
  series.forEach((p, i) => {
    const c = el('circle', { class: 'dot', cx: x(i), cy: y(p.score), r: 4.5 });
    const title = document.createElementNS(NS, 'title');
    title.textContent = `${fmtDate(p.date, { dateStyle: 'medium' })} · ${p.mood} (${p.score > 0 ? '+' : ''}${p.score}) · ${p.title}`;
    c.append(title);
  });
  const every = Math.max(1, Math.ceil(series.length / 6));
  series.forEach((p, i) => { if (i % every === 0 || i === series.length - 1) el('text', { x: x(i), y: H - 10, 'text-anchor': 'middle' }, fmtDate(p.date, { month: 'short', day: 'numeric' })); });
  return svg;
}

/* =========================================================================
   Ask my journal (retrieval over the user's own entries)
   ========================================================================= */
const ASK_SUGGESTIONS = ['When did I last feel genuinely calm?', 'What keeps stressing me about work?', 'What has helped me sleep better?', 'Which people show up when I am happiest?'];

async function renderAsk() {
  const root = clear($('#ask-root'));
  root.append(h('h1', { text: 'Ask my journal' }), h('p', { class: 'muted', text: 'Gemini searches only your own entries (semantic search on Firestore) and answers with citations. Nothing leaves your account.' }));

  const status = h('p', { class: 'muted', style: 'font-size:.85rem' });
  const reindexBtn = h('button', { class: 'btn btn-sm', type: 'button', text: 'Index older entries', hidden: true });
  const refreshStatus = async () => {
    try {
      const s = await api('/ask/status');
      status.textContent = s.total ? `${s.indexed} of ${s.total} entries are searchable.` : 'Write a few entries first, then come back and ask.';
      reindexBtn.hidden = s.indexed >= s.total;
    } catch (err) { status.textContent = err.message; }
  };
  reindexBtn.addEventListener('click', async () => {
    reindexBtn.disabled = true; reindexBtn.textContent = 'Indexing…';
    try { const r = await api('/ask/reindex', { method: 'POST' }); toast(`Indexed ${r.embedded} entries.`); await refreshStatus(); }
    catch (err) { toast(err.message, true); }
    finally { reindexBtn.disabled = false; reindexBtn.textContent = 'Index older entries'; }
  });
  refreshStatus();

  const input = h('input', { type: 'text', maxlength: '500', placeholder: 'Ask anything about what you have written…', 'aria-label': 'Question' });
  const askBtn = h('button', { class: 'btn btn-primary', type: 'submit', text: 'Ask' });
  const result = h('div', {});
  const form = h('form', { class: 'card', novalidate: true },
    h('div', { class: 'row between' }, status, reindexBtn),
    h('div', { class: 'composer', style: 'margin-top:.75rem' }, input, askBtn),
    h('div', { class: 'chips', style: 'margin-top:.75rem' }, ...ASK_SUGGESTIONS.map((q) => h('button', { type: 'button', class: 'chip', text: q, onClick: () => { input.value = q; form.requestSubmit(); } }))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return input.focus();
    askBtn.disabled = true; askBtn.textContent = 'Thinking…';
    clear(result).append(h('div', { class: 'card' }, h('div', { class: 'typing' }, h('i'), h('i'), h('i'))));
    try {
      const d = await api('/ask', { method: 'POST', body: { question } });
      clear(result);
      if (!d.answer) { result.append(h('div', { class: 'card muted', text: d.message || 'No related entries found.' })); return; }
      result.append(
        h('div', { class: 'card' },
          h('h3', { text: question }),
          h('div', { class: 'reflection' }, renderMarkdown(d.answer)),
          h('h3', { style: 'margin-top:1rem;font-size:.85rem;color:var(--muted)', text: 'Sources' }),
          h('ul', { style: 'margin:0;padding-left:1.1rem' }, ...d.sources.map((s) =>
            h('li', {}, h('a', { href: `#/entry/${s.id}`, text: `[${s.n}] ${s.title}` }), ' ',
              h('span', { class: 'muted', text: `· ${fmtDate(s.createdAt, { dateStyle: 'medium' })}${s.mood ? ` · ${MOOD_EMOJI[s.mood] || ''} ${s.mood}` : ''}${s.similarity !== null ? ` · ${s.similarity}% match` : ''}` }))))));
    } catch (err) {
      clear(result).append(h('div', { class: 'card error', text: err.message }));
    } finally { askBtn.disabled = false; askBtn.textContent = 'Ask'; }
  });
  root.append(form, h('div', { style: 'margin-top:1rem' }, result));
  input.focus();
}

/* =========================================================================
   Voice notes (MediaRecorder -> Gemini transcription)
   ========================================================================= */
function voiceButton(onTranscript) {
  const btn = h('button', { type: 'button', class: 'btn btn-sm', text: '🎤 Record' });
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { btn.disabled = true; btn.title = 'Recording is not supported in this browser'; return btn; }
  let rec = null; let chunks = []; let timer = null; let started = 0;
  const stop = () => { if (rec && rec.state !== 'inactive') rec.stop(); };
  btn.addEventListener('click', async () => {
    if (rec && rec.state === 'recording') return stop();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
      rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = []; started = Date.now();
      rec.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
      rec.addEventListener('stop', async () => {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        btn.textContent = 'Transcribing…'; btn.disabled = true;
        try {
          const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
          const base64 = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1]); fr.onerror = reject; fr.readAsDataURL(blob); });
          const d = await api('/voice/transcribe', { method: 'POST', body: { mimeType: blob.type, audio: base64 } });
          if (d.text) onTranscript(d.text); else toast(d.message || 'Nothing transcribed.', true);
        } catch (err) { toast(err.message, true); }
        finally { btn.textContent = '🎤 Record'; btn.disabled = false; }
      });
      rec.start();
      btn.textContent = '■ Stop 0:00';
      timer = setInterval(() => {
        const s = Math.floor((Date.now() - started) / 1000);
        btn.textContent = `■ Stop ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        if (s >= 90) stop();
      }, 500);
    } catch (err) { toast(err.name === 'NotAllowedError' ? 'Microphone permission was denied.' : 'Could not start recording.', true); }
  });
  return btn;
}

/* =========================================================================
   Account
   ========================================================================= */
function renderAccount() {
  const root = clear($('#account-root'));
  const p = state.profile || {};
  const u = state.user;
  root.append(
    h('h1', { text: 'Account' }),
    h('div', { class: 'card' },
      h('h3', { text: 'Profile' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Name' }), h('dd', { text: u.displayName || '—' }),
        h('dt', { text: 'Email' }), h('dd', { text: u.email || '—' }),
        h('dt', { text: 'Sign-in method' }), h('dd', { text: u.providerData.map((x) => x.providerId.replace('.com', '')).join(', ') || 'email' }),
        h('dt', { text: 'Member since' }), h('dd', { text: fmtDate(p.createdAt, { dateStyle: 'long' }) || '—' }),
        h('dt', { text: 'Entries' }), h('dd', { text: String(p.entryCount ?? 0) }),
        h('dt', { text: 'Role' }), h('dd', { text: p.admin ? 'admin' : 'member' }),
        h('dt', { text: 'User ID' }), h('dd', {}, h('code', { text: u.uid })))),
    h('div', { class: 'card' },
      h('h3', { text: 'Your data' }),
      h('p', { class: 'muted', text: 'Everything is stored under your own user ID in Cloud Firestore. Firestore security rules and the API only ever allow the signed-in owner to read it. You can take it with you or erase it any time.' }),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', text: 'Download my data (JSON)', onClick: exportData }))),
    notificationsCard(),
    h('div', { class: 'card danger-zone' },
      h('h3', { text: 'Delete account' }),
      h('p', { class: 'muted', text: 'Permanently deletes every entry, conversation, insight and your sign-in. This cannot be undone.' }),
      h('button', { class: 'btn btn-danger', type: 'button', text: 'Delete my account and data', onClick: deleteAccount })),
    h('div', { class: 'card' },
      h('h3', { text: 'How this app protects you' }),
      h('ul', { class: 'muted', style: 'margin:0;padding-left:1.2rem' },
        h('li', { text: 'Firebase Authentication issues short-lived ID tokens; the server verifies one on every request.' }),
        h('li', { text: 'All data lives under users/{yourId}. The server never queries across users.' }),
        h('li', { text: 'The Gemini and Maps API keys live in Google Cloud Secret Manager and never reach the browser.' }),
        h('li', { text: 'Gemini is told to treat your writing as data, never as instructions.' }),
        h('li', { text: 'Strict Content-Security-Policy, rate limits and input limits protect the service.' })))
  );
}

/** External notifications (Slack / Discord webhook) settings card. */
function notificationsCard() {
  const status = h('p', { class: 'muted', text: 'Loading…' });
  const url = h('input', { type: 'url', maxlength: '400', placeholder: 'https://hooks.slack.com/services/…  or  https://discord.com/api/webhooks/…', 'aria-label': 'Webhook URL', autocomplete: 'off' });
  const lowMood = h('input', { type: 'checkbox', id: 'nf-lowmood' });
  const milestones = h('input', { type: 'checkbox', id: 'nf-milestones' });
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit', text: 'Save' });
  const test = h('button', { class: 'btn btn-sm', type: 'button', text: 'Send test', disabled: true });
  const remove = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: 'Disconnect', hidden: true });

  const paint = (s) => {
    status.textContent = s.configured ? `Connected to ${s.provider} (${s.host}). Messages never include your journal text.` : 'Not connected. Paste a Slack or Discord incoming-webhook URL to get gentle nudges.';
    lowMood.checked = s.lowMood; milestones.checked = s.milestones;
    test.disabled = !s.configured; remove.hidden = !s.configured;
    url.placeholder = s.configured ? '•••••••• (saved) - paste a new URL to replace' : url.placeholder;
  };
  api('/account/notifications').then(paint).catch((e) => (status.textContent = e.message));

  const form = h('form', { novalidate: true },
    url,
    h('div', { class: 'row', style: 'margin-top:.6rem' },
      h('label', { for: 'nf-lowmood', style: 'margin:0;display:flex;gap:.4rem;align-items:center;font-weight:500;color:var(--text)' }, lowMood, 'Nudge me after a very low-mood entry'),
      h('label', { for: 'nf-milestones', style: 'margin:0;display:flex;gap:.4rem;align-items:center;font-weight:500;color:var(--text)' }, milestones, 'Celebrate milestones (7, 30, 100 entries)')),
    h('div', { class: 'row', style: 'margin-top:.8rem' }, save, test, remove));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    try {
      const body = { lowMood: lowMood.checked, milestones: milestones.checked };
      if (url.value.trim()) body.webhookUrl = url.value.trim();
      paint(await api('/account/notifications', { method: 'PUT', body }));
      url.value = '';
      toast('Notification settings saved.');
    } catch (err) { toast(err.message, true); } finally { save.disabled = false; }
  });
  test.addEventListener('click', async () => {
    test.disabled = true;
    try { await api('/account/notifications/test', { method: 'POST' }); toast('Test message sent.'); }
    catch (err) { toast(err.message, true); } finally { test.disabled = false; }
  });
  remove.addEventListener('click', async () => {
    try { paint(await api('/account/notifications', { method: 'PUT', body: { webhookUrl: '', lowMood: false, milestones: false } })); toast('Webhook removed.'); }
    catch (err) { toast(err.message, true); }
  });

  return h('div', { class: 'card' },
    h('h3', { text: 'Notifications' }),
    status,
    form,
    h('p', { class: 'muted', style: 'font-size:.78rem;margin:.6rem 0 0', text: 'Only https Slack and Discord webhook hosts are accepted; the URL is stored server-side and never shown again.' }));
}

async function exportData() {
  try {
    const token = await state.user.getIdToken();
    const res = await fetch('/api/account/export', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Export failed');
    const blob = await res.blob();
    const a = h('a', { href: URL.createObjectURL(blob), download: `journal-export-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a); a.click(); a.remove();
    toast('Export downloaded.');
  } catch (err) { toast(err.message, true); }
}

async function deleteAccount() {
  const ok = await confirmDialog({
    title: 'Delete your account?',
    text: 'Type DELETE MY JOURNAL to confirm. All entries, conversations and your login will be erased permanently.',
    okLabel: 'Delete everything',
    requireText: 'DELETE MY JOURNAL',
  });
  if (!ok) return;
  try {
    await api('/account', { method: 'DELETE', body: { confirm: 'DELETE MY JOURNAL' } });
    toast('Your account and data have been deleted.');
    await signOut(auth);
    location.hash = '#/journal';
  } catch (err) { toast(err.message, true); }
}

/* =========================================================================
   Admin (role-based, aggregates only)
   ========================================================================= */
async function renderAdmin() {
  const root = clear($('#admin-root'));
  root.append(h('h1', { text: 'Admin dashboard' }), h('p', { class: 'muted', text: 'Visible only to users with the admin custom claim. Shows service health and aggregate usage. User identifiers are hashed; journal content is never accessible here.' }));
  let d;
  try { d = await api('/admin/overview'); }
  catch (err) { root.append(h('p', { class: 'error', text: err.message })); return; }
  const s = d.stats || {};
  root.append(h('div', { class: 'stats' },
    stat(s.users || 0, 'users'), stat(s.entries || 0, 'entries'), stat(s.aiMessages || 0, 'AI messages'), stat(s.reflections || 0, 'weekly reflections'), stat(s.deletedAccounts || 0, 'accounts erased')));
  root.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h3', { text: 'Service' }),
      h('dl', { class: 'kv' },
        h('dt', { text: 'Cloud Run service' }), h('dd', {}, h('code', { text: d.service.name })),
        h('dt', { text: 'Revision' }), h('dd', {}, h('code', { text: d.service.revision })),
        h('dt', { text: 'Gemini model' }), h('dd', {}, h('code', { text: d.service.model })),
        h('dt', { text: 'Maps geocoding' }), h('dd', { text: d.service.mapsEnabled ? 'enabled' : 'disabled (no key configured)' }),
        h('dt', { text: 'Node' }), h('dd', { text: d.service.node }))),
    h('div', { class: 'card' }, h('h3', { text: 'Recent sign-ups' }),
      h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'User (hashed)' }), h('th', { text: 'Joined' }), h('th', { text: 'Last seen' }), h('th', { text: 'Entries' }))),
        h('tbody', {}, ...d.recentUsers.map((u) => h('tr', {}, h('td', {}, h('code', { text: u.id })), h('td', { text: fmtDate(u.createdAt, { dateStyle: 'medium' }) }), h('td', { text: fmtDate(u.lastSeenAt) }), h('td', { text: String(u.entryCount) })))))))));
  root.append(h('div', { class: 'card', style: 'margin-top:1rem' }, h('h3', { text: 'Audit trail' }),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'When' }), h('th', { text: 'Event' }), h('th', { text: 'Subject (hashed)' }), h('th', { text: 'Details' }))),
      h('tbody', {}, ...d.recentAudit.map((a) => h('tr', {}, h('td', { text: fmtDate(a.at) }), h('td', {}, h('code', { text: a.event })), h('td', {}, h('code', { text: a.subject })), h('td', { class: 'muted', text: JSON.stringify(a.meta || {}) }))))))));
}

boot();
