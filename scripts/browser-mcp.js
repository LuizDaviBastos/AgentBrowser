const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHROME_PROFILE = path.join(ROOT_DIR, '.runtime', 'chrome-profile');
const CHROME_PORT = 9222;
const CHROME_URL = `http://127.0.0.1:${CHROME_PORT}`;
const LOG_FILE = path.join(ROOT_DIR, '.runtime', 'browser-mcp.log');

if (!fs.existsSync(CHROME_PROFILE)) fs.mkdirSync(CHROME_PROFILE, { recursive: true });

function trace(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

async function main() {
  trace(`launcher start pid=${process.pid} node=${process.execPath}`);
  await ensureChrome();
  trace(`chrome ready url=${CHROME_URL}`);

  const worker = resolveWorkerCommand();
  trace(`starting worker command=${worker.command} args=${worker.args.join(' ')}`);
  const child = spawn(worker.command, worker.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: {
      ...process.env,
    },
  });
  trace(`spawned chrome-devtools-mcp pid=${child.pid}`);

  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    trace(`child stderr ${text.trimEnd()}`);
    process.stderr.write(`[browser-mcp] ${text}`);
  });

  const shutdown = () => {
    trace('launcher shutdown requested');
    try { child.kill(); } catch {}
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  child.on('exit', (code, signal) => {
    trace(`child exit code=${code} signal=${signal || ''}`);
    process.exit(code ?? 0);
  });
  child.on('error', err => {
    trace(`child error ${err?.message || err}`);
    console.error(err);
    process.exit(1);
  });
}

async function ensureChrome() {
  if (process.platform !== 'win32') {
    await ensureChromeLinux();
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`, { method: 'GET' });
    if (res.ok) {
      trace('chrome already running');
      return;
    }
  } catch {}

  trace('starting chrome');
  const chrome = spawn(CHROME_EXE, [
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  });
  chrome.unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`, { method: 'GET' });
      if (res.ok) {
        trace('chrome ready after start');
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  trace('failed to start chrome');
  throw new Error(`Failed to start Chrome on port ${CHROME_PORT}.`);
}

async function ensureChromeLinux() {
  try {
    const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`, { method: 'GET' });
    if (res.ok) {
      trace('chrome already running');
      return;
    }
  } catch {}

  trace('starting chromium via puppeteer');
  const puppeteer = require('puppeteer');
  let browser;
  try {
    browser = await launchChromium(puppeteer);
  } catch (err) {
    if (isMissingChromiumError(err)) {
      trace('chromium missing, installing browser');
      await installChromium();
      browser = await launchChromium(puppeteer);
    } else {
      throw err;
    }
  }
  const browserProc = browser.process();
  if (browserProc) {
    browserProc.on('exit', (code, signal) => trace(`chromium exit code=${code} signal=${signal || ''}`));
  }

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`, { method: 'GET' });
      if (res.ok) {
        trace('chrome ready after start');
        return;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  trace('failed to start chromium');
  await browser.close().catch(() => {});
  throw new Error(`Failed to start Chromium on port ${CHROME_PORT}.`);
}

async function launchChromium(puppeteer) {
  return puppeteer.launch({
    headless: 'new',
    args: [
      `--remote-debugging-port=${CHROME_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--new-window',
      'about:blank',
    ],
  });
}

function isMissingChromiumError(err) {
  const text = String(err && err.message ? err.message : err || '');
  return /Could not find Chrome|Chrome \(ver\./i.test(text);
}

async function installChromium() {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'exec',
    '--yes',
    'puppeteer',
    '--',
    'browsers',
    'install',
    'chrome',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
    },
  });
  child.stdout.on('data', chunk => trace(`chromium install stdout ${chunk.toString().trimEnd()}`));
  child.stderr.on('data', chunk => trace(`chromium install stderr ${chunk.toString().trimEnd()}`));
  const code = await new Promise(resolve => child.on('exit', resolve));
  if (code !== 0) {
    throw new Error(`Failed to install Chromium (exit code ${code})`);
  }
}

function resolveWorkerCommand() {
  if (process.platform === 'win32') {
    return [
      'npm.cmd',
      [
        'exec',
        '--yes',
        'chrome-devtools-mcp@latest',
        '--',
        '--browser-url',
        CHROME_URL,
        ...process.argv.slice(2),
      ],
    ];
  }
  return [
    'npm',
    [
      'exec',
      '--yes',
      'chrome-devtools-mcp@latest',
      '--',
      '--browser-url',
      CHROME_URL,
      ...process.argv.slice(2),
    ],
  ];
}

main().catch(err => {
  trace(`launcher fatal ${err?.message || err}`);
  console.error(err);
  process.exit(1);
});
