// Copies the window's HTML and CSS next to the compiled renderer script.
import { copyFileSync, mkdirSync } from 'node:fs';
const out = 'dist/apps/agent/src/renderer';
mkdirSync(out, { recursive: true });
for (const f of ['index.html', 'styles.css']) copyFileSync(`src/renderer/${f}`, `${out}/${f}`);
