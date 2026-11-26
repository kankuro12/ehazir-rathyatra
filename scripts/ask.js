// Terminal prompts for setup scripts. hidden:true masks typing (passwords, API keys).
// One shared readline so pasted / piped multi-line input is not lost between questions.
const readline = require('node:readline');

let rl, hide = false, prompt = '';
const lines = [], waiting = [];
function init() {
  if (rl) return;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdout.isTTY });
  rl._writeToOutput = (s) => rl.output.write(!hide || s.startsWith(prompt) ? s : s.replace(/[^\r\n]/g, '*'));
  rl.on('line', (l) => { const w = waiting.shift(); if (w) w(l); else lines.push(l); });
  rl.on('close', () => { while (waiting.length) waiting.shift()(''); });
}

function ask(question, { hidden = false } = {}) {
  init();
  hide = hidden; prompt = question;
  rl.output.write(question);
  return new Promise((resolve) => {
    const done = (a) => { if (hidden) rl.output.write('\n'); hide = false; resolve(String(a).trim()); };
    if (lines.length) done(lines.shift()); else waiting.push(done);
  });
}

async function askPassword(label = 'Password') {
  for (;;) {
    const pw = await ask(`${label} (min 10 chars): `, { hidden: true });
    if (pw.length < 10) { console.log('  too short'); continue; }
    if (pw !== await ask('Repeat password: ', { hidden: true })) { console.log('  passwords do not match'); continue; }
    return pw;
  }
}

const closeAsk = () => rl?.close();

module.exports = { ask, askPassword, closeAsk };
