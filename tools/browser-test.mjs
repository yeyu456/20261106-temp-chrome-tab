// 真机验证：用 CDP（--remote-debugging-pipe）把扩展装进一个临时 Chrome，跑一遍收纳/取回/撤销，
// 再给侧边栏截图。需要以完全权限运行（Chrome 的崩溃上报进程会被沙箱拦住）。
//   node tools/browser-test.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const EXT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(EXT, 'docs');

class PipeTransport {
  constructor(proc) {
    this.proc = proc;
    this.buffer = '';
    this.pending = new Map();
    this.nextId = 1;
    this.listeners = new Set();
    proc.stdio[4].setEncoding('utf8');
    proc.stdio[4].on('data', (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\0')) >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!raw) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners) listener(message);
      }
    }
  }

  onMessage(listener) {
    this.listeners.add(listener);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.proc.stdio[3].write(`${JSON.stringify(payload)}\0`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }
      }, 20000);
    });
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'tabshelf-'));
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-features=Translate',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );

  const transport = new PipeTransport(chrome);
  const pageErrors = [];
  transport.onMessage((message) => {
    if (message.method === 'Runtime.exceptionThrown') {
      pageErrors.push(message.params.exceptionDetails?.exception?.description || 'unknown exception');
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  });

  chrome.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`chrome exited with ${code}`);
  });

  try {
    await sleep(1200);
    const { id: extensionId } = await transport.send('Extensions.loadUnpacked', { path: EXT });
    console.log(`extension loaded: ${extensionId}`);
    check('扩展能加载', !!extensionId, extensionId);

    const panelUrl = `chrome-extension://${extensionId}/src/sidepanel/panel.html`;
    const openTab = async (url) => {
      const { targetId } = await transport.send('Target.createTarget', { url });
      return targetId;
    };

    // 打开两个待收纳的标签页，最后打开收纳箱页面（成为当前标签页）
    await openTab('chrome://version');
    await openTab('chrome://settings');
    const panelTargetId = await openTab(panelUrl);
    const { sessionId } = await transport.send('Target.attachToTarget', { targetId: panelTargetId, flatten: true });
    const call = (method, params) => transport.send(method, params, sessionId);
    await call('Runtime.enable');
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 820, deviceScaleFactor: 2, mobile: false });

    const evaluate = async (expression) => {
      const result = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || JSON.stringify(result.exceptionDetails));
      }
      return result.result.value;
    };

    await sleep(800);
    const pageInfo = await evaluate(`({
      url: location.href,
      title: document.title,
      parkLabel: document.getElementById('parkLabel').textContent,
      disabled: document.getElementById('parkBtn').disabled,
      hasPanelCss: !!document.querySelector('link[rel=stylesheet]'),
    })`);
    console.log('panel page:', JSON.stringify(pageInfo));
    check('侧边栏页面可打开', pageInfo.url === panelUrl);
    check('收纳按钮显示标签数', /收纳其他 \d+ 个标签页/.test(pageInfo.parkLabel), pageInfo.parkLabel);

    const send = (message) => evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);

    const before = await evaluate('chrome.tabs.query({ currentWindow: true }).then(t => t.length)');
    const parkResult = await send({ type: 'park' });
    console.log('park:', JSON.stringify(parkResult));
    check('收纳返回结果', parkResult.ok && parkResult.parked === 2, JSON.stringify(parkResult));

    const afterPark = await evaluate('chrome.tabs.query({ currentWindow: true }).then(t => t.length)');
    check('其他标签页已关闭', afterPark === 1 && before - afterPark === parkResult.closed, `${before} -> ${afterPark}`);

    const state1 = await evaluate('chrome.storage.local.get("shelfState").then(r => r.shelfState)');
    check('已保存地址与标题', state1.batches[0].items.length === 2 && state1.batches[0].items.every((item) => item.url && item.title), JSON.stringify(state1.batches[0].items.map((item) => item.title)));

    const batchId = state1.batches[0].id;
    const itemId = state1.batches[0].items[0].id;
    const restore = await send({ type: 'restore', batchId, itemId });
    check('点击条目能重新打开', restore.ok && !!restore.tabId, JSON.stringify(restore));

    await sleep(300);
    const afterRestore = await evaluate('chrome.tabs.query({ currentWindow: true }).then(t => t.length)');
    const state2 = await evaluate('chrome.storage.local.get("shelfState").then(r => r.shelfState)');
    check('取回后条目从箱子移除', afterRestore === 2 && state2.batches[0].items.length === 1, `${afterRestore} tabs, ${state2.batches[0].items.length} items`);

    const undo1 = await send({ type: 'undo' });
    await sleep(300);
    const afterUndo = await evaluate('chrome.tabs.query({ currentWindow: true }).then(t => t.length)');
    const state3 = await evaluate('chrome.storage.local.get("shelfState").then(r => r.shelfState)');
    check('撤销取回（关掉新标签、条目回箱）', undo1.ok && afterUndo === 1 && state3.batches[0].items.length === 2, `${afterUndo} tabs, ${state3.batches[0].items.length} items`);

    const batchOpen = await send({ type: 'openBatch', batchId });
    await sleep(500);
    const afterBatch = await evaluate('chrome.tabs.query({ currentWindow: true }).then(t => t.length)');
    check('整批打开', batchOpen.ok && batchOpen.opened === 2 && afterBatch === 3, JSON.stringify(batchOpen));

    const undo2 = await send({ type: 'undo' });
    await sleep(300);
    const afterUndo2 = await evaluate('chrome.tabs.query({ currentWindow: true }).then(t => t.length)');
    const state4 = await evaluate('chrome.storage.local.get("shelfState").then(r => r.shelfState)');
    check('撤销整批打开', undo2.ok && afterUndo2 === 1 && state4.batches[0].items.length === 2, `${afterUndo2} tabs`);

    const settings = await send({ type: 'setSettings', settings: { skipPinned: true } });
    check('设置可保存', settings.ok && settings.settings.skipPinned === true);

    await send({ type: 'setSettings', settings: { skipPinned: false } });

    // 关闭测试留下的标签页，准备截图
    const extraTabs = await evaluate('chrome.tabs.query({ currentWindow: true }).then(t => t.map(x => ({ id: x.id, url: x.url })))');
    const keepId = extraTabs.find((tab) => tab.url.startsWith('chrome-extension://'))?.id;
    const closeIds = extraTabs.filter((tab) => tab.id !== keepId).map((tab) => tab.id);
    if (closeIds.length) await evaluate(`chrome.tabs.remove(${JSON.stringify(closeIds)})`);

    await openTab('https://example.com/');
    await openTab('https://developer.chrome.com/docs/extensions');
    await openTab('chrome://version');
    await transport.send('Target.activateTarget', { targetId: panelTargetId });

    await evaluate(`chrome.storage.local.set({ shelfState: ${JSON.stringify(demoState())} })`);
    await call('Page.reload');
    await sleep(1200);
    await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 820, deviceScaleFactor: 2, mobile: false });
    await sleep(600);

    const shot = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fs.writeFile(path.join(OUT, 'panel-light.png'), Buffer.from(shot.data, 'base64'));

    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await sleep(400);
    const dark = await call('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fs.writeFile(path.join(OUT, 'panel-dark.png'), Buffer.from(dark.data, 'base64'));

    const finalInfo = await evaluate(`({ parkLabel: document.getElementById('parkLabel').textContent, items: document.querySelectorAll('.item').length, batches: document.querySelectorAll('.batch').length })`);
    console.log('render:', JSON.stringify(finalInfo));
    check('列表渲染出条目', finalInfo.items === 7 && finalInfo.batches === 2, JSON.stringify(finalInfo));

    // 搜索、键盘、窄宽度
    await evaluate(`(() => { const input = document.getElementById('search'); input.value = 'github'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    check('搜索能过滤', (await evaluate(`document.querySelectorAll('.item').length`)) === 1);
    await evaluate(`(() => { const input = document.getElementById('search'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('.item').focus()`);
    await evaluate(`document.querySelector('.item').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
    check('方向键能移动焦点', (await evaluate(`document.activeElement === document.querySelectorAll('.item')[1]`)) === true);
    await call('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 2, mobile: false });
    check('窄面板无横向溢出', (await evaluate(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`)) === true);
    await call('Emulation.setDeviceMetricsOverride', { width: 400, height: 820, deviceScaleFactor: 2, mobile: false });

    // 额外的界面状态截图：设置弹层、打开后的 toast、空箱
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await evaluate(`document.getElementById('settingsBtn').click()`);
    await sleep(500);
    check('设置弹层可打开', (await evaluate(`document.getElementById('settingsDialog').open`)) === true);
    await fs.writeFile(
      path.join(OUT, 'panel-settings.png'),
      Buffer.from((await call('Page.captureScreenshot', { format: 'png', fromSurface: true })).data, 'base64'),
    );
    await evaluate(`document.getElementById('settingsDialog').close()`);

    await evaluate(`document.querySelector('.item .del').click()`);
    await sleep(900);
    check('删除后有撤销提示', (await evaluate(`document.getElementById('toast').classList.contains('show')`)) === true);
    await fs.writeFile(
      path.join(OUT, 'panel-toast.png'),
      Buffer.from((await call('Page.captureScreenshot', { format: 'png', fromSurface: true })).data, 'base64'),
    );

    await evaluate(`chrome.storage.local.set({ shelfState: { v: 1, settings: { skipPinned: false, skipAudible: false }, batches: [] } })`);
    await sleep(700);
    await fs.writeFile(
      path.join(OUT, 'panel-empty.png'),
      Buffer.from((await call('Page.captureScreenshot', { format: 'png', fromSurface: true })).data, 'base64'),
    );
    const emptyInfo = await evaluate(`({ empty: !document.getElementById('empty').hidden, footerHidden: document.getElementById('footer').hidden })`);
    check('空箱状态正确', emptyInfo.empty === true && emptyInfo.footerHidden === true, JSON.stringify(emptyInfo));

    if (pageErrors.length) {
      console.log('page errors:', JSON.stringify(pageErrors, null, 2));
      check('页面无 JS 报错', false, pageErrors.join(' | '));
    } else {
      check('页面无 JS 报错', true);
    }
  } finally {
    chrome.kill();
    await sleep(500);
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
}

function letterIcon(letter, color) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32">` +
    `<rect width="32" height="32" rx="7" fill="${color}"/>` +
    `<text x="16" y="22.5" font-family="Segoe UI, Arial" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function demoState() {
  const now = Date.now();
  const make = (url, title, letter, color, pinned = false) => ({
    id: `t_${Math.random().toString(36).slice(2, 9)}`,
    url,
    title,
    favIconUrl: letterIcon(letter, color),
    pinned,
    audible: false,
    idx: 0,
  });

  return {
    v: 1,
    settings: { skipPinned: false, skipAudible: false },
    batches: [
      {
        id: 'b_demo_recent',
        createdAt: now - 25 * 60 * 1000,
        items: [
          make('https://github.com/pulls', 'Pull requests · GitHub', 'G', '#24292f'),
          make('https://www.zhihu.com/question/620123456', '如何评价 Chrome 新的标签页收纳方案？ - 知乎', '知', '#1772f6'),
          make('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Chrome DevTools 深度讲解：从 Performance 面板到内存分析 - YouTube', 'Y', '#ff0033'),
          make('https://juejin.cn/post/7312345678901234567', '手写一个标签页管理器：MV3 里那些容易踩的坑 - 掘金', '掘', '#1e80ff'),
          make('https://developer.mozilla.org/zh-CN/docs/Web/API/tabs', 'tabs API - MDN Web Docs', 'M', '#1b1b1b'),
        ],
      },
      {
        id: 'b_demo_yesterday',
        createdAt: now - 26 * 60 * 60 * 1000,
        items: [
          make('https://www.figma.com/file/abcdefg/Design-System', 'Design System · Figma', 'F', '#a259ff'),
          make('https://www.notion.so/workspace/Chrome-8432', 'Chrome 标签页改造方案 · Notion', 'N', '#111111'),
        ],
      },
    ],
  };
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
