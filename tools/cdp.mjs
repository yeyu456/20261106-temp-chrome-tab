// 开发期调试工具：通过 CDP 驱动一个临时 Chrome，验证扩展 / 截图 UI。
// 用法（需先启动带 --remote-debugging-port 的 Chrome）：
//   node tools/cdp.mjs list
//   node tools/cdp.mjs newtab "chrome://extensions"
//   node tools/cdp.mjs eval <url 片段> "document.body.innerText"
//   node tools/cdp.mjs shot <url 片段> out.png [width] [height]
//   node tools/cdp.mjs click <url 片段> "<css selector>"

const PORT = process.env.CDP_PORT || 9225;
const BASE = `http://127.0.0.1:${PORT}`;

async function listTargets() {
  const response = await fetch(`${BASE}/json/list`);
  return response.json();
}

class Session {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    });
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    const id = (this.id += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'evaluate failed');
    }
    return result.result.value;
  }

  close() {
    this.ws.close();
  }
}

async function connect(match) {
  const targets = await listTargets();
  const target = targets.find((item) => item.webSocketDebuggerUrl && item.url.includes(match));
  if (!target) {
    throw new Error(`no target matching ${JSON.stringify(match)}. available:\n${targets.map((t) => `${t.type} ${t.url}`).join('\n')}`);
  }
  return Session.open(target.webSocketDebuggerUrl);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'list') {
    const targets = await listTargets();
    for (const target of targets) console.log(`${target.type}\t${target.url}`);
    return;
  }

  if (command === 'newtab') {
    const url = args[0] || 'about:blank';
    const response = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const target = await response.json();
    console.log(`${target.type}\t${target.url}`);
    await sleep(Number(process.env.CDP_WAIT || 800));
    return;
  }

  if (command === 'eval') {
    const [match, expression] = args;
    const session = await connect(match);
    await session.send('Runtime.enable');
    console.log(JSON.stringify(await session.evaluate(expression), null, 2));
    session.close();
    return;
  }

  if (command === 'shot') {
    const [match, out, width = '400', height = '820'] = args;
    const session = await connect(match);
    await session.send('Runtime.enable');
    await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', {
      width: Number(width),
      height: Number(height),
      deviceScaleFactor: 2,
      mobile: false,
    });
    await sleep(Number(process.env.CDP_WAIT || 600));
    const shot = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const fs = await import('node:fs/promises');
    await fs.writeFile(out, Buffer.from(shot.data, 'base64'));
    console.log(`saved ${out}`);
    session.close();
    return;
  }

  if (command === 'click') {
    const [match, selector] = args;
    const session = await connect(match);
    await session.send('Runtime.enable');
    const ok = await session.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
    console.log(ok ? 'clicked' : 'not found');
    session.close();
    return;
  }

  console.error('unknown command');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
