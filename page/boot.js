(async () => {
  const status = document.getElementById("status");
  try {
    if (!window.magpie) throw new Error("请从 Magpie 侧栏打开远端看板。");
    const theme = await magpie.ready;
    const options = await magpie.options.get();
    const port = Number(options.port ?? 3487);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("看板端口无效");
    const service = magpie.service;
    let base;
    if (typeof service === "string" && service) {
      base = new URL(service, location.href);
    } else {
      const host = location.hostname.replace(/^\[|\]$/g, "");
      if (host && host !== "localhost" && host !== "::1" && !/^127\./.test(host)) throw new Error("宿主未提供看板服务代理");
      base = new URL(`http://127.0.0.1:${port}/`);
    }
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("看板服务地址无效");
    const target = new URL("dashboard/", base.href.replace(/\/?$/, "/"));
    target.searchParams.set("theme", theme?.dark ? "dark" : "light");
    location.replace(target.href);
  } catch (error) {
    status.textContent = error.message || "看板服务尚未就绪";
    document.getElementById("retry").hidden = false;
  }
})();
document.getElementById("retry").addEventListener("click", () => location.reload());
