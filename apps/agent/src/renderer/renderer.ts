/** Agent window: setup → explicit consent → pairing → status (FR-ATT-011; ADR 018). */
type LinkState = 'connecting' | 'online' | 'offline' | 'revoked' | 'unpaired';
interface UiState {
  screen: 'setup' | 'status';
  apiUrl: string;
  defaultDeviceName: string;
  status: { link: LinkState; activity: 'active' | 'idle'; email: string | null; buffered: number; lastSync: { at: number; accepted: number } | null; message: string | null; storage: string | null };
}
interface Notice { version: string; title: string; summary: string; monitoringSummary: string }
interface Bridge {
  state(): Promise<UiState>;
  notice(apiUrl: string): Promise<Notice>;
  pair(input: { apiUrl: string; code: string; deviceName: string; consentNoticeVersion: string }): Promise<UiState>;
  disconnect(): Promise<UiState>;
  quit(): Promise<void>;
  onState(cb: (s: UiState) => void): void;
}
const agent = (window as unknown as { agent: Bridge }).agent;
const root = document.getElementById('app')!;

/** Builds DOM from text only (no innerHTML with data). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const c of children) e.append(c);
  return e;
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Something went wrong');

let setup = { step: 'server' as 'server' | 'consent' | 'pair', apiUrl: '', notice: null as Notice | null, agreed: false };

function render(s: UiState): void {
  root.replaceChildren();
  if (s.screen === 'status') return renderStatus(s);
  if (!setup.apiUrl) setup.apiUrl = s.apiUrl;
  if (setup.step === 'server') return renderServer(s);
  if (setup.step === 'consent') return renderConsent();
  return renderPair(s);
}

function renderServer(s: UiState): void {
  const input = el('input', { id: 'server', type: 'url', value: setup.apiUrl, placeholder: 'https://hr.example.com/api', autocomplete: 'url' });
  const error = el('p', { class: 'error', role: 'alert' });
  const go = el('button', { type: 'submit' }, 'Continue');
  const form = el('form', {}, el('label', { for: 'server' }, 'Server address'), input,
    el('p', { class: 'muted' }, 'Your HR team gives you this address. It is the same server the web app uses.'), error, el('div', { class: 'row' }, go));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go.disabled = true;
    error.textContent = '';
    agent.notice(input.value.trim()).then((n) => { setup = { ...setup, step: 'consent', apiUrl: input.value.trim(), notice: n }; render(s); })
      .catch((err: unknown) => { error.textContent = errMsg(err); go.disabled = false; });
  });
  root.append(el('h1', {}, 'Set up the HRVO Agent'), s.status.message ? el('p', { class: 'muted' }, s.status.message) : '', form);
  input.focus();
}

function renderConsent(): void {
  const n = setup.notice!;
  const box = el('input', { type: 'checkbox', id: 'agree' });
  const agree = el('button', { type: 'button', disabled: '' }, 'Agree and continue');
  const decline = el('button', { type: 'button', class: 'secondary' }, 'Decline and quit');
  box.addEventListener('change', () => { agree.disabled = !box.checked; });
  agree.addEventListener('click', () => { setup = { ...setup, step: 'pair', agreed: true }; void agent.state().then(render); });
  decline.addEventListener('click', () => void agent.quit());
  root.append(
    el('h1', {}, n.title),
    el('div', { class: 'card', 'data-testid': 'consent-notice' },
      el('p', {}, n.summary),
      el('h2', {}, 'What the agent reads'),
      el('ul', {}, el('li', {}, 'How many seconds the computer has had no keyboard or mouse input (OS idle time).'), el('li', {}, 'Whether the screen is locked.')),
      el('h2', {}, 'What it never reads'),
      el('ul', {}, el('li', {}, 'Keystrokes, screenshots, window titles, websites, files or application names.')),
      el('h2', {}, 'How it works'),
      el('ul', {},
        el('li', {}, 'A tray icon is shown whenever the agent runs. Quitting the agent stops tracking.'),
        el('li', {}, 'Without a connection, activity is kept on this computer (encrypted) for up to 12 hours and sent when you are back online. That time is marked for your manager to review.'),
        el('li', {}, 'You can disconnect this device at any time, here or in the web app.')),
      el('p', { class: 'muted' }, `Attendance monitoring: ${n.monitoringSummary}`),
      el('p', { class: 'muted' }, `Notice version ${n.version}`)),
    el('label', { class: 'check', for: 'agree' }, box, 'I have read this notice and agree to the desktop agent.'),
    el('div', { class: 'row' }, agree, decline),
  );
}

function renderPair(s: UiState): void {
  const code = el('input', { id: 'code', type: 'text', class: 'code', maxlength: '9', placeholder: 'XXXX-XXXX', autocomplete: 'one-time-code', spellcheck: 'false' });
  const name = el('input', { id: 'device', type: 'text', value: s.defaultDeviceName, maxlength: '100' });
  const error = el('p', { class: 'error', role: 'alert' });
  const go = el('button', { type: 'submit' }, 'Connect');
  const back = el('button', { type: 'button', class: 'secondary' }, 'Back');
  back.addEventListener('click', () => { setup = { ...setup, step: 'server', agreed: false }; render(s); });
  const form = el('form', {},
    el('p', {}, 'In the web app, open My desktop agents and choose Connect a desktop agent. Enter the code it shows (valid for 5 minutes).'),
    el('label', { for: 'code' }, 'Pairing code'), code, el('label', { for: 'device' }, 'Name of this computer'), name, error, el('div', { class: 'row' }, go, back));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    go.disabled = true;
    error.textContent = '';
    agent.pair({ apiUrl: setup.apiUrl, code: code.value.trim(), deviceName: name.value.trim(), consentNoticeVersion: setup.notice!.version })
      .then((next) => { setup = { step: 'server', apiUrl: '', notice: null, agreed: false }; render(next); })
      .catch((err: unknown) => { error.textContent = errMsg(err); go.disabled = false; });
  });
  root.append(el('h1', {}, 'Connect this computer'), form);
  code.focus();
}

const LINK_LABEL: Record<LinkState, string> = { online: 'Connected', connecting: 'Connecting…', offline: 'Offline', revoked: 'Disconnected', unpaired: 'Not connected' };

function renderStatus(s: UiState): void {
  const st = s.status;
  const disconnect = el('button', { type: 'button', class: 'secondary' }, 'Disconnect this device');
  const quit = el('button', { type: 'button', class: 'secondary' }, 'Quit (stops tracking)');
  disconnect.addEventListener('click', () => { if (window.confirm('Disconnect this computer? You will have to pair it again.')) void agent.disconnect().then(render); });
  quit.addEventListener('click', () => void agent.quit());
  root.append(
    el('h1', {}, 'HRVO Agent'),
    el('div', { class: 'card' }, el('dl', {},
      el('dt', {}, 'Status'), el('dd', { class: `state ${st.link}`, 'data-testid': 'link-state' }, LINK_LABEL[st.link]),
      el('dt', {}, 'Activity'), el('dd', { 'data-testid': 'activity' }, st.activity === 'active' ? 'Active' : 'Idle'),
      el('dt', {}, 'Signed in as'), el('dd', {}, st.email ?? '-'),
      el('dt', {}, 'Saved offline'), el('dd', { 'data-testid': 'buffered' }, `${st.buffered} interval${st.buffered === 1 ? '' : 's'} (${Math.round((st.buffered * 30) / 60)} min)`),
      el('dt', {}, 'Last sync'), el('dd', {}, st.lastSync ? `${new Date(st.lastSync.at).toLocaleTimeString()} (${st.lastSync.accepted} accepted)` : 'Never'))),
    st.message ? el('p', { 'data-testid': 'agent-message' }, st.message) : '',
    st.storage ? el('p', { class: 'muted' }, st.storage) : '',
    el('p', { class: 'muted' }, 'Reads only the OS idle time and lock state. Close this window to keep the agent in the tray.'),
    el('div', { class: 'row' }, disconnect, quit),
  );
}

agent.onState((s) => { if (s.screen === 'status' || document.querySelector('[data-testid=link-state]')) render(s); });
void agent.state().then(render);
