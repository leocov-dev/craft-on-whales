import { defineRouter } from '#q-app';
import {
  createMemoryHistory,
  createRouter,
  createWebHashHistory,
  createWebHistory,
} from 'vue-router';
import { Dialog } from 'quasar';

import routes from './routes';
import { useAuthStore } from '@/stores/auth';
import { useWorldUploadStore } from '@/stores/world-upload';

function confirmLeaveActiveUpload(): Promise<boolean> {
  return new Promise((resolve) => {
    Dialog.create({
      title: 'World upload in progress',
      message:
        'A world archive is currently uploading or being processed. Navigating away may interrupt the transfer. Are you sure you want to leave?',
      cancel: {
        label: 'Stay',
        flat: true,
      },
      ok: {
        label: 'Leave',
        color: 'negative',
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });
}

/*
 * If not building with SSR mode, you can
 * directly export the Router instantiation;
 *
 * The function below can be async too; either use
 * async/await or return a Promise which resolves
 * with the Router instance.
 */

export default defineRouter((/* { store, ssrContext } */) => {
  const createHistory = import.meta.env.QUASAR_SERVER
    ? createMemoryHistory
    : import.meta.env.QUASAR_VUE_ROUTER_MODE === 'history'
      ? createWebHistory
      : createWebHashHistory;

  const Router = createRouter({
    scrollBehavior: () => ({ left: 0, top: 0 }),
    routes,

    // Leave this as is and make changes in quasar.conf.js instead!
    // quasar.conf.js -> build -> vueRouterMode
    // quasar.conf.js -> build -> publicPath
    history: createHistory(import.meta.env.QUASAR_VUE_ROUTER_BASE),
  });

  Router.beforeEach(async (to, from) => {
    const uploadStore = useWorldUploadStore();
    if (uploadStore.isActive && from.matched.length > 0 && to.fullPath !== from.fullPath) {
      const confirmed = await confirmLeaveActiveUpload();
      if (!confirmed) {
        return false;
      }
    }

    const isPublic = to.matched.some((record) => record.meta.public);
    const auth = useAuthStore();

    if (auth.status === 'unknown') {
      await auth.fetchSession();
    }
    if (auth.firstRunNeeded === null) {
      await auth.fetchFirstRunNeeded();
    }

    if (auth.firstRunNeeded && to.path !== '/setup') {
      return { path: '/setup' };
    }
    if (!auth.firstRunNeeded && !auth.isAuthenticated && to.path === '/setup') {
      return { path: '/login' };
    }
    if (!isPublic && !auth.isAuthenticated) {
      return { path: '/login', query: to.fullPath !== '/' ? { next: to.fullPath } : {} };
    }
    const isAdminOnly = to.matched.some((record) => record.meta.adminOnly);
    if (isAdminOnly && !auth.isAdmin) {
      return { path: '/' };
    }
    if (isPublic && auth.isAuthenticated && (to.path === '/login' || to.path === '/setup')) {
      return { path: '/' };
    }
    return true;
  });

  return Router;
});
