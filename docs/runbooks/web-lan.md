# Runbook: use HRVO from other devices on your network (HTTPS)

Camera, microphone and the attendance heartbeat only work on a secure page: `https://`, or `http://localhost` on the computer itself. To open HRVO from a phone or another computer on the same Wi-Fi, run it over HTTPS with `scripts/lan-https.sh`. This is for a local demo with the generated demo accounts, not a deployment.

## Start

The containers must be running first (`docker compose up -d`, or `podman compose up -d`).

```bash
bash scripts/lan-https.sh start     # finds this computer's IP, issues a certificate, starts web, API and the TLS proxy
bash scripts/lan-https.sh status    # which address it was started for, and whether each port answers
bash scripts/lan-https.sh stop
```

Open the address it prints, for example `https://192.168.52.124:3443`. Sign in as `worker@acme.demo` (password `DemoPassword123!`).

| Port | Service |
| --- | --- |
| 3443 | web app |
| 3444 | API |
| 7443 | LiveKit (meetings) |
| 8443 | document storage |

## One-time step: trust the certificate authority

The first start creates a small certificate authority in `.lan-https/ca.pem` (gitignored; the private key never leaves this computer). Import `ca.pem` once in every browser that will open HRVO. Afterwards no port shows a warning, also after your IP address changes.

- **Brave / Chrome:** Settings → Privacy and security → Security → Manage certificates → Authorities → Import → `ca.pem` → tick "Trust this certificate for identifying websites".
- **Firefox:** Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → `ca.pem` → tick "Trust this CA to identify websites".
- **Phone / another computer:** copy `ca.pem` to it and install it as a CA certificate.

Restart the browser after importing.

## When it does not work

- **The page does not open at all:** your IP address probably changed (Wi-Fi networks hand out new ones). Run `bash scripts/lan-https.sh status`: if "Started for" differs from "Current address", run `start` again.
- **Sign-in says it cannot reach the server, or meetings or uploads fail:** the browser does not trust the certificate on one of the ports. Import `ca.pem` as above. `.lan-https/logs/proxy.log` shows "TLS handshake refused" for each refused connection.
- **Another device cannot connect but this computer can:** a firewall blocks the ports. On Fedora: `sudo firewall-cmd --add-port={3443,3444,7443,8443}/tcp`.
- **Logs:** `.lan-https/logs/api.log`, `web.log`, `proxy.log`.

Do not delete `.lan-https/ca-key.pem` unless you want to re-import a new authority everywhere. Remove the authority from your browsers when you no longer need it.
