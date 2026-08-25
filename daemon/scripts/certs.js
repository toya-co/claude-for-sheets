#!/usr/bin/env node
/**
 * Make the self-signed certificate the loopback server needs.
 *
 * This was an npm script with the openssl command inline, and it carried a
 * Windows-shell workaround: `-subj "//CN=localhost"`. The doubled slash is
 * there because MSYS (Git Bash) rewrites a leading `/` into a Windows path, so
 * `/CN=localhost` arrives as `C:/Program Files/Git/CN=localhost`. On Linux and
 * macOS that same doubled slash is just wrong, which made the one command
 * everybody has to run before anything works platform-specific.
 *
 * Running openssl through Node with `shell: false` puts the arguments in front
 * of the OS directly, so no shell rewrites anything and one spelling is correct
 * everywhere. Zero dependencies, like the rest of the daemon.
 *
 * The certificate is for `localhost` and `127.0.0.1` only, it is not secret,
 * and it is regenerated rather than shared — `*.pem` is gitignored.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'certs');
const KEY = path.join(DIR, 'key.pem');
const CERT = path.join(DIR, 'cert.pem');
const DAYS = 365;

if (fs.existsSync(KEY) && fs.existsSync(CERT) && !process.argv.includes('--force')) {
  console.log('certificate already present:', CERT);
  console.log('(pass --force to replace it)');
  process.exit(0);
}

fs.mkdirSync(DIR, { recursive: true });

const args = [
  'req', '-x509', '-newkey', 'rsa:2048',
  '-keyout', KEY, '-out', CERT,
  '-days', String(DAYS), '-nodes',
  '-subj', '/CN=localhost',
  '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
];

const run = spawnSync('openssl', args, { shell: false, encoding: 'utf8' });

if (run.error && run.error.code === 'ENOENT') {
  console.error('openssl is not on PATH.');
  console.error('  macOS/Linux: it is almost certainly installed — check your PATH.');
  console.error('  Windows: Git for Windows ships it, at');
  console.error('           C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
  process.exit(1);
}
if (run.status !== 0) {
  console.error('openssl failed:\n' + (run.stderr || '').trim());
  process.exit(1);
}

console.log('wrote ' + path.relative(process.cwd(), CERT));
console.log('     ' + path.relative(process.cwd(), KEY));
console.log(`valid ${DAYS} days, for localhost and 127.0.0.1 only`);
