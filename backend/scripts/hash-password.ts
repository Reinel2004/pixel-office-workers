// Creates a password hash for APP_USERS. Run it on your own computer or server:
//   npm run hash-password
// Type the password when asked (it is not echoed). Copy the printed line into your server's
// environment settings. Never paste passwords or hashes into chats or tickets.

import { stdin, stdout } from 'node:process';
import { hashPassword } from '../src/auth';

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    stdout.write(prompt);
    let value = '';
    const raw = stdin.isTTY;
    if (raw) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          stdin.off('data', onData);
          if (raw) stdin.setRawMode(false);
          stdin.pause();
          stdout.write('\n');
          return resolve(value);
        }
        if (c === '\u0003') process.exit(1);
        if (c === '\u007f') value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on('data', onData);
  });
}

const username = process.argv[2] ?? 'owner';
const role = process.argv[3] ?? 'admin';
const pw = await ask(`Password for ${username}: `);
if (pw.length < 10) {
  console.error('Use at least 10 characters.');
  process.exit(1);
}
const again = await ask('Repeat password: ');
if (pw !== again) {
  console.error('Passwords do not match.');
  process.exit(1);
}
console.log(`\nAdd this entry to APP_USERS (comma-separate multiple users):\n${username}:${role}:${await hashPassword(pw)}`);
