# Open HRVO on your phone or another computer (same Wi-Fi)

HRVO needs a secure `https://` address for the camera, the microphone and automatic attendance tracking. On the computer that runs HRVO, `http://localhost:3000` is enough. Any other device (a phone, a laptop) needs HTTPS, and that device must **trust** the certificate, or the browser shows "Your connection is not private" (`ERR_CERT_AUTHORITY_INVALID`).

This guide sets that up once. It takes about 15 minutes, most of it on the phone.

> This is for a demo on your own network with the demo accounts. It is not a production setup.

## The short version

```bash
# 1. This computer's address on the Wi-Fi (Linux; macOS: ipconfig getifaddr en0; Windows: ipconfig)
ip -4 route get 1.1.1.1 | grep -oP 'src \K[\d.]+'        # e.g. 192.168.52.124
hostname -I                                               # every address, first one is usually the Wi-Fi

# 2. Containers (database, Redis, storage, ClamAV, KMS, LiveKit), then HRVO over HTTPS
docker compose up -d        # or: podman compose up -d
npm run lan:up              # finds the address, makes the certificate, starts proxy + API + web, checks
npm run lan:check           # repeat the checks at any time
npm run lan:down            # stop
```

| Where | Address | Notes |
| --- | --- | --- |
| This computer | `http://localhost:3000` | plain HTTP; a secure context because it is localhost |
| This computer, through the proxy | `https://localhost:3443` or `https://127.0.0.1:3443` | the certificate covers both |
| Phone / other computer | `https://192.168.52.124:3443` (your address) | the device must trust the root certificate, Part 2 |
| Phone, plain HTTP (no `lan:up`; plain `npm run api` + `npm run web`) | `http://192.168.52.124:3000` | sign-in and everything else work, but not the camera, microphone or heartbeat signing (no secure context) |

Behind the web app, the same address serves the API on `:3444`, LiveKit signalling on `:7443` and document storage on `:8443`. The web app finds them by itself: it talks to the API at the host the page was opened from (`localhost` on this computer, your address on a phone), so nothing is hard-coded to `localhost` (ADR 036). While `lan:up` runs, the API accepts browser requests only from the `https://` addresses (plus `https://localhost:3443` and `https://127.0.0.1:3443`); without it, the API accepts `http://localhost:3000`, `http://127.0.0.1:3000` and any private-network address on port 3000.

## How it works (in plain words)

- A **root certificate** ("your stamp") is created once on your computer: by **mkcert** when it is installed, otherwise by **OpenSSL** in `.lan-https/ca.pem`. Its private key never leaves the computer.
- `npm run lan:certs` uses that stamp to make **one certificate with many names**: your network address, every other address of the computer (Ethernet, hotspot), `localhost`, `127.0.0.1` and `::1`. When the address changes, run `npm run lan:up` again; devices keep trusting the stamp.
- A small **TLS proxy** (`scripts/lan-proxy.ts`, Node only; or Caddy with `LAN_PROXY=caddy`) gives HRVO its `https://` addresses with that certificate and forwards to the web app, the API, LiveKit and storage on this computer. The API, the web dev server and the proxy all listen on `0.0.0.0`, so other devices can reach them.
- Each phone or computer that should open HRVO is told once to trust your stamp. After that, the lock icon is shown and there is no warning.

Why "proceed anyway" is not a fix: meetings, uploads and sign-in use four addresses, and each one would fail separately. Trust the stamp once instead.

## Part 1: on the computer that runs HRVO (once)

1. **Optional: install mkcert** (it makes this computer's own browsers trust the stamp automatically).
   - Fedora: `sudo dnf install mkcert nss-tools`, Ubuntu / Debian: `sudo apt install mkcert libnss3-tools`, macOS: `brew install mkcert nss`, Windows (as administrator): `choco install mkcert`. Then `mkcert -install` and restart your browsers.
   - Without mkcert, OpenSSL is used (installed on Linux and macOS). Then this computer's browsers need the import from Part 2 like any other device, unless you open HRVO as `http://localhost:3000`.
2. **Start HRVO with HTTPS:** in the HRVO folder, with the containers running:

   ```bash
   npm run lan:up
   ```

   It prints the address to open, for example `https://192.168.52.124:3443`, and a list where every line should say `OK`.

   - To choose the address yourself (a fixed IP or a name such as `hrvo.local`): `LAN_HOST=192.168.1.20 npm run lan:up`.
   - **Production build:** `LAN_WEB_MODE=production npm run lan:up`. The web app's addresses are written into a production build, so after the address changes you must build again; this command does it for you.
   - To keep the servers on this computer only: `LAN_BIND=127.0.0.1 npm run lan:up` (then only the proxy ports are reachable from the network).
3. **Allow the ports through the firewall** if another device cannot connect: Fedora `sudo firewall-cmd --add-port={3000,3001,3443,3444,7443,8443}/tcp` (add `--permanent` and `--reload` to keep it); Ubuntu `sudo ufw allow 3443,3444,7443,8443/tcp`; Windows answers "Allow" when asked.

Check at any time: `npm run lan:check`. Stop: `npm run lan:down`.

## Part 2: trust your stamp on each phone or computer (once per device)

First, make the stamp available to the device. On the HRVO computer run:

```bash
npm run lan:share-ca
```

It prints an address such as `http://192.168.52.124:8099/hrvo-root.crt` and a **fingerprint** (a long code). The address works for 10 minutes. The file is only the public half of the stamp; the secret half never leaves the computer.

Before you trust it on the device, check that the fingerprint shown on the device matches the one printed on the computer.

### iPhone / iPad

1. Open **Safari** (not Chrome) and go to the printed address, e.g. `http://192.168.52.124:8099/hrvo-root.crt`.
2. Tap **Allow** when asked to download a configuration profile, then **Close**.
3. Open **Settings**. Near the top, tap **Profile Downloaded**. (Or: Settings → General → VPN & Device Management → the "HRVO local development CA" or "mkcert" profile.)
4. Tap **Install** (top right), enter your passcode, tap **Install** again, then **Done**.
5. Now switch on full trust (this step is easy to miss): **Settings → General → About → Certificate Trust Settings**. Under "Enable full trust for root certificates", turn on the switch next to the certificate, and tap **Continue**.
6. Open Safari and go to the HRVO address, e.g. `https://192.168.52.124:3443`. You see the lock and no warning.

### Android

Menu names differ slightly between makers; search Settings for "certificate" if you cannot find them.

1. Open the printed address in **Chrome**; the file `hrvo-root.crt` is downloaded.
2. Open **Settings → Security and privacy → More security settings → Encryption & credentials → Install a certificate → CA certificate**.
3. Tap **Install anyway**, confirm with your screen lock, and choose **hrvo-root.crt** from Downloads.
4. Check it under **Trusted credentials → User**: the entry is there.
5. Open the HRVO address in **Chrome**. (Some apps ignore certificates you installed yourself; Chrome uses them.)

### Windows computer

1. Download `hrvo-root.crt` with `npm run lan:share-ca`, or copy the root file from the HRVO computer (`.lan-https/ca.pem`, or `rootCA.pem` in the folder `mkcert -CAROOT` prints).
2. Double-click the file → **Install Certificate…** → **Current User** → **Place all certificates in the following store** → **Browse** → **Trusted Root Certification Authorities** → **Next** → **Finish** → **Yes**.
3. Restart the browser. Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → **Import**, tick "Trust this CA to identify websites".

### macOS computer

1. Double-click `hrvo-root.crt`; **Keychain Access** opens. Choose the **login** keychain and **Add**.
2. In Keychain Access, double-click the certificate → **Trust** → "When using this certificate": **Always Trust**. Close the window and enter your password.
3. Restart the browser. Firefox: import it as above.

### Linux computer (also the HRVO computer itself, when OpenSSL made the stamp)

- Chrome / Brave / Chromium: Settings → Privacy and security → Security → Manage certificates → Authorities (or "Installed by you") → **Import** the root file, tick "Trust this certificate for identifying websites". Restart the browser.
- Firefox: Settings → Privacy & Security → Certificates → View Certificates → Authorities → **Import**, tick "Trust this CA to identify websites".
- From a terminal, for Chrome/Brave/Chromium (needs `nss-tools` / `libnss3-tools`): `certutil -d sql:$HOME/.pki/nssdb -A -t C,, -n "HRVO local CA" -i .lan-https/ca.pem`
- If mkcert made the stamp and is installed on that computer too, `mkcert -install` does all of this at once.

### Quick test without trusting anything (Chrome only, not for real use)

For a one-off look on a test device you can tell Chrome to treat the plain `http://` address as secure, so the camera and microphone work without a certificate. On that device open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enter `http://192.168.52.124:3000` (your address), set it to **Enabled**, and relaunch Chrome. This changes only that browser on that device; it does not make the connection encrypted, and Safari has no such setting. Remove the entry when you are done.

## When something does not work

| What you see | What to do |
| --- | --- |
| "Your connection is not private" / `ERR_CERT_AUTHORITY_INVALID` | This device does not trust the stamp yet: Part 2. On iPhone, do not forget step 5 (full trust). |
| `ERR_CERT_COMMON_NAME_INVALID` | The address changed (new Wi-Fi). Run `npm run lan:up` again; it makes a certificate for the new address. Devices keep trusting the stamp. |
| The page does not load at all | Firewall (Part 1, step 3), or a different network. `npm run lan:check` on the computer; `.lan-https/logs/proxy.log` shows refused handshakes. |
| Sign-in fails, meetings or uploads fail | `npm run lan:check`: every line must say OK. Each service has its own address. |
| "The camera only works on a secure connection" in a meeting | You opened an `http://` address. Use the `https://` address printed by `npm run lan:up`. |
| Chrome says "Blocked cross-origin request" in the dev server log | The address is not in `allowedDevOrigins` (apps/web/next.config.mjs lists this computer's addresses and `LAN_HOST` at start). Restart with `npm run lan:up`. |

Never share the private key of the stamp (`.lan-https/ca-key.pem`, or `rootCA-key.pem` in the folder `mkcert -CAROOT` prints): with it, anyone could make certificates your devices trust. When you no longer need the demo, remove the certificate from your devices, delete `.lan-https/`, and run `mkcert -uninstall` if mkcert made it.

## Alternative: a tunnel (reach HRVO from anywhere)

A tunnel such as **Cloudflare Tunnel** or **Tailscale Funnel** gives HRVO a real `https://` address with a certificate every device already trusts, so no device setup is needed. The full steps are in [demo-internet.md](demo-internet.md) (Cloudflare Tunnel and LiveKit Cloud). **Tailscale** without Funnel is a private alternative: only devices signed in to your Tailscale network can reach it (`tailscale serve`).

> **Warning: a public tunnel (Cloudflare Tunnel, Tailscale Funnel) puts the demo on the internet.** Anyone who finds the address can try to sign in.
> - Replace every demo password with a strong random one (at least 16 random characters, different for each account), e.g. `npm run seed:demo:internet`, which generates them.
> - Switch two-factor sign-in on: remove `AUTH_MFA_ENFORCEMENT=off` from `.env` and have everyone set up 2FA.
> - Use only invented data: no real people, documents, tax or bank details.
> - Shut the tunnel down as soon as the demo is over (`npm run demo:internet:teardown`), and never leave it running unattended.
