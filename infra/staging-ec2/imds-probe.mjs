// Probe of the EC2 instance metadata service for verify-imds-isolation.sh (ADR 047). Runs inside a
// container's network namespace and prints one line: "blocked (...)" or "reachable (...)". It never
// prints the token, the role name or any credential; it does not request credentials at all.
const base = process.argv[2] ?? 'http://169.254.169.254';
const signal = () => AbortSignal.timeout(3000);
try {
  const r = await fetch(`${base}/latest/api/token`, {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    signal: signal(),
  });
  if (!r.ok) {
    console.log(`reachable (token request answered ${r.status})`);
  } else {
    const token = await r.text();
    const info = await fetch(`${base}/latest/meta-data/iam/info`, { headers: { 'X-aws-ec2-metadata-token': token }, signal: signal() });
    console.log(`reachable (instance profile ${info.status === 200 ? 'attached' : 'not attached'})`);
  }
} catch (e) {
  console.log(`blocked (${e?.cause?.code ?? e?.name ?? 'error'})`);
}
