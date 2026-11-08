(async () => {
  const status = document.getElementById('status');
  const retry = document.getElementById('retry');
  retry.addEventListener('click', () => location.reload());
  const fail = (message) => {
    status.textContent = message;
    retry.hidden = false;
  };
  if (!window.magpie) {
    fail('请从 Magpie 的插件页面打开，或使用 bun run start 启动独立服务。');
    return;
  }
  try {
    const theme = await Promise.race([
      magpie.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Magpie 页面桥接未响应。')), 9000)),
    ]);
    const options = await magpie.options?.get?.();
    const port = options?.port === undefined || options?.port === null || options?.port === '' ? 3487 : Number(options.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('插件 port 选项必须为 1–65535 的整数。');
    }
    const service = magpie.service;
    let target;
    if (typeof service === 'string' && /^https?:\/\//.test(service)) {
      target = new URL(service);
    } else {
      const host = location.hostname.replace(/^\[|\]$/g, '');
      if (host && host !== 'localhost' && host !== '::1' && !/^127\./.test(host)) {
        throw new Error('当前宿主没有提供插件服务代理。请更新 Magpie，或在运行 Magpie 的机器上打开独立服务。');
      }
      target = new URL(`http://127.0.0.1:${port}/`);
    }
    target.searchParams.set('theme', theme?.dark ? 'dark' : 'light');
    setTimeout(() => fail('插件服务未响应。请检查服务端口、配置文件，或重新启用插件。'), 6000);
    location.replace(target.href);
  } catch (error) {
    fail(error.message || '无法连接插件服务。');
  }
})();
