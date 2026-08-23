import { Dark } from 'quasar';
import { defineBoot } from '#q-app';

const STORAGE_KEY = 'msm-theme';

export type ThemeName = 'dark' | 'light';

export function currentTheme(): ThemeName {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function setTheme(theme: ThemeName) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  Dark.set(theme === 'dark');
}

export default defineBoot(() => {
  // index.html's pre-paint script already set data-theme from localStorage /
  // prefers-color-scheme to avoid a flash; bring Quasar's own dark-mode flag
  // into sync so stock components pick the right palette on first render.
  Dark.set(currentTheme() === 'dark');
});
