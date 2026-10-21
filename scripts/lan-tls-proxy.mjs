// TLS in front of the local services for LAN use (scripts/lan-https.sh). Each HTTPS port is a raw
// TCP pipe to the plain-HTTP service behind it, so HTTP, WebSockets and LiveKit signalling all work.
// Usage: node scripts/lan-tls-proxy.mjs <dir with key.pem and cert.pem>
import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/lan-tls-proxy.mjs <tls dir>');
  process.exit(2);
}
const options = { key: fs.readFileSync(`${dir}/key.pem`), cert: fs.readFileSync(`${dir}/cert.pem`) };

// HTTPS port -> local service: web app, API, LiveKit, document storage.
const ROUTES = [[3443, 3000], [3444, 3001], [7443, 7880], [8443, 8333]];

for (const [from, to] of ROUTES) {
  const server = tls.createServer(options, (client) => {
    const backend = net.connect(to, '127.0.0.1');
    client.pipe(backend).pipe(client);
    const end = () => { client.destroy(); backend.destroy(); };
    client.on('error', end);
    backend.on('error', end);
    client.on('close', end);
    backend.on('close', end);
  });
  // A browser that has not trusted the certificate yet shows up here, once per connection attempt.
  server.on('tlsClientError', (err) => console.error(`port ${from}: TLS handshake refused (${err.code ?? err.message}); is the HRVO certificate authority imported?`));
  server.listen(from, '0.0.0.0', () => console.log(`https :${from} -> http :${to}`));
}
