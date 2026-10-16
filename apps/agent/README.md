# HRVO desktop agent

Optional Electron app (SRS FR-ATT-011, FR-ATT-012; ADR 018). It reads only the OS idle time and the
lock state, shows a tray icon whenever it runs, and buffers activity while offline.

```bash
npm run build -w @hrvo/agent          # compile to apps/agent/dist
npm test -w @hrvo/agent               # unit tests (tracker, offline buffer)
HRVO_API_URL=http://localhost:3001 npm start -w @hrvo/agent   # run against the local API
npm run dist:linux -w @hrvo/agent     # AppImage + deb in apps/agent/release (dist:win, dist:mac on those systems)
```

`npm start` drops `ELECTRON_RUN_AS_NODE` (VS Code terminals set it, which would make Electron run as plain Node).

Pairing: in the web app open **My desktop agents → Connect a desktop agent**, then enter the code in the agent.
