// Small terminal prompts. A typed secret is never echoed; with no terminal, a line is read from
// standard input instead, so `printf secret | reolook init --user x` works in scripts.
import readline from 'node:readline';

/** All of standard input as text. */
async function readAllStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Asks a question and returns the answer line. With no terminal, prints the question and reads the first line of standard input. @param {string} question @returns {Promise<string>}
 */
export async function askLine(question) {
  if (!process.stdin.isTTY) { process.stdout.write(question); return (await readAllStdin()).split(/\r?\n/)[0]; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

/**
 * Asks for a secret without echoing it. With no terminal, reads the first line of standard input and prints nothing. Rejects with 'cancelled' on Ctrl-C. @param {string} question @returns {Promise<string>}
 */
export function askSecret(question) {
  if (!process.stdin.isTTY) return readAllStdin().then((t) => t.split(/\r?\n/)[0]);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    /** Restores the terminal and finishes with `fn(v)` (resolve or reject). */
    const done = (fn, v) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stdout.write('\n'); fn(v); };
    /**
     * Handles typed characters: Enter or Ctrl-D finishes, Ctrl-C cancels, Backspace deletes, printable characters are added.
     */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(resolve, buf);
        if (ch === '\u0003') return done(reject, new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
        else if (ch >= ' ') buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
