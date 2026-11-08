// The page's entry: Magpie's theme as the bridge passed it, the two views,
// and their setup. Built into one script by the service (ui-bundle.ts).

import { byId } from "./dom.ts";
import { setupObservations } from "./observe/cards.ts";
import { loadPools, setupPools } from "./pools.ts";

function setupTheme(): void {
  const root = document.documentElement;
  const toggle = byId<HTMLButtonElement>("theme-toggle");
  const themes = [null, "light", "dark"] as const;
  const labels = ["跟随系统", "浅色主题", "深色主题"];
  const host = root.dataset.hostTheme;
  let index = host === "light" ? 1 : host === "dark" ? 2 : 0;
  const show = () => {
    const theme = themes[index];
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
    toggle.textContent = labels[index] ?? "跟随系统";
    toggle.setAttribute("aria-label", `当前${labels[index]}，点击切换主题`);
  };
  toggle.addEventListener("click", () => {
    index = (index + 1) % themes.length;
    show();
  });
  show();
}

function setupTabs(): void {
  const tabs = [
    { tab: byId<HTMLButtonElement>("tab-observe"), view: byId("view-observe") },
    { tab: byId<HTMLButtonElement>("tab-pools"), view: byId("view-pools"), open: () => void loadPools() },
  ];
  let poolsLoaded = false;
  for (const entry of tabs) {
    entry.tab.addEventListener("click", () => {
      for (const other of tabs) {
        const selected = other === entry;
        other.tab.setAttribute("aria-selected", String(selected));
        other.view.hidden = !selected;
      }
      if (entry.open && !poolsLoaded) {
        poolsLoaded = true;
        entry.open();
      }
    });
  }
}

setupTheme();
setupTabs();
setupObservations();
setupPools();
