import type { RouteRecordRaw } from 'vue-router';

// Route meta: `public` routes skip the auth guard entirely; everything else
// requires a session (checked in router/index.ts's beforeEach against
// stores/auth.ts). This mirrors src/web/middleware/auth.ts's requireAuth,
// which remains the real enforcement boundary — this guard is UX-only.
declare module 'vue-router' {
  interface RouteMeta {
    public?: boolean;
  }
}

const authLayout = () => import('@/layouts/AuthLayout.vue');

const routes: RouteRecordRaw[] = [
  // Each auth page is its own top-level route (rather than nested children
  // sharing a '/' parent alongside MainLayout below) — Vue Router's matcher
  // dedupes route records by exact parent path, so two records both
  // declaring `path: '/'` collide and only the first-registered one's
  // children ever resolve. Distinct top-level paths avoid that entirely.
  {
    path: '/login',
    component: authLayout,
    meta: { public: true },
    children: [{ path: '', component: () => import('@/pages/LoginPage.vue') }],
  },
  {
    path: '/login/2fa',
    component: authLayout,
    meta: { public: true },
    children: [{ path: '', component: () => import('@/pages/Login2faPage.vue') }],
  },
  {
    path: '/setup',
    component: authLayout,
    meta: { public: true },
    children: [{ path: '', component: () => import('@/pages/SetupPage.vue') }],
  },

  {
    path: '/status/:slug',
    component: () => import('@/pages/StatusPage.vue'),
    meta: { public: true },
  },

  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', component: () => import('@/pages/DashboardPage.vue') },
      { path: 'servers', component: () => import('@/pages/ServersPage.vue') },
      { path: 'servers/new', component: () => import('@/pages/WizardPage.vue') },
      { path: 'activity', component: () => import('@/pages/ActivityPage.vue') },
      { path: 'schedules', component: () => import('@/pages/SchedulesPage.vue') },
      { path: 'mc-router', component: () => import('@/pages/McRouterPage.vue') },
      { path: 'storage', component: () => import('@/pages/StoragePage.vue') },
      { path: 'settings', component: () => import('@/pages/SettingsPage.vue') },
      { path: 'blueprints', component: () => import('@/pages/BlueprintsPage.vue') },
      { path: 'modpacks', component: () => import('@/pages/ModpacksPage.vue') },
      { path: 'worlds', component: () => import('@/pages/WorldsPage.vue') },
      { path: 'backups', component: () => import('@/pages/BackupsPage.vue') },
      { path: 'updates', component: () => import('@/pages/UpdatesPage.vue') },
      { path: 'files', component: () => import('@/pages/FilesPage.vue') },
      {
        path: 'servers/:id/players/:name',
        component: () => import('@/pages/PlayerDetailPage.vue'),
      },
      {
        path: 'servers/:id',
        component: () => import('@/layouts/ServerDetailLayout.vue'),
        children: [
          { path: '', redirect: (to) => `/servers/${String(to.params.id)}/overview` },
          { path: ':tab', component: () => import('@/pages/server/ServerTabView.vue') },
        ],
      },
    ],
  },

  {
    path: '/:catchAll(.*)*',
    component: () => import('@/pages/ErrorNotFound.vue'),
  },
];

export default routes;
