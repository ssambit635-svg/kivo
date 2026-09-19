import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pyScript = path.join(__dirname, 'build-apk.py');

try {
  execSync(`python3 "${pyScript}"`, { stdio: 'inherit' });
} catch (err) {
  console.error('Failed to build APK:', err);
  process.exit(1);
}
