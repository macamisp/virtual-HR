// Starts the agent with Electron. Drops ELECTRON_RUN_AS_NODE (set by VS Code terminals), which
// would otherwise make Electron run as plain Node.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env }).on('exit', (code) => process.exit(code ?? 0));
