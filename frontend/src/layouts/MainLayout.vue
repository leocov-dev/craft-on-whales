<template>
  <q-layout view="lHh Lpr lFf">
    <q-header bordered class="bg-surface text-ink">
      <q-toolbar>
        <q-btn flat dense round icon="menu" class="lt-lg" @click="drawerOpen = !drawerOpen" />
        <q-toolbar-title class="row items-center q-gutter-x-sm">
          <q-icon name="construction" color="primary" />
          <span>Craft on Whales</span>
        </q-toolbar-title>
        <q-btn flat round :icon="isDark ? 'light_mode' : 'dark_mode'" @click="toggleTheme" />
        <q-btn-dropdown flat no-caps :label="auth.user?.username">
          <q-list>
            <q-item clickable v-close-popup to="/settings">
              <q-item-section avatar><q-icon name="settings" /></q-item-section>
              <q-item-section>Settings</q-item-section>
            </q-item>
            <q-item clickable v-close-popup @click="onLogout">
              <q-item-section avatar><q-icon name="logout" /></q-item-section>
              <q-item-section>Sign out</q-item-section>
            </q-item>
          </q-list>
        </q-btn-dropdown>
      </q-toolbar>
    </q-header>

    <q-drawer v-model="drawerOpen" show-if-above bordered class="bg-surface">
      <q-list padding>
        <q-item v-for="link in navLinks" :key="link.to" clickable v-ripple :to="link.to" exact>
          <q-item-section avatar>
            <q-icon :name="link.icon" />
          </q-item-section>
          <q-item-section>{{ link.label }}</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { currentTheme, setTheme } from '@/boot/theme';

const router = useRouter();
const auth = useAuthStore();

const drawerOpen = ref(false);
const isDark = ref(currentTheme() === 'dark');

function toggleTheme() {
  const next = isDark.value ? 'light' : 'dark';
  setTheme(next);
  isDark.value = next === 'dark';
}

async function onLogout() {
  await auth.logout();
  await router.push('/login');
}

const navLinks = [
  { label: 'Dashboard', to: '/', icon: 'home' },
  { label: 'Servers', to: '/servers', icon: 'dns' },
  { label: 'Modpacks', to: '/modpacks', icon: 'inventory_2' },
  { label: 'Worlds', to: '/worlds', icon: 'public' },
  { label: 'Blueprints', to: '/blueprints', icon: 'architecture' },
  { label: 'Updates', to: '/updates', icon: 'upgrade' },
  { label: 'Backups', to: '/backups', icon: 'archive' },
  { label: 'Schedules', to: '/schedules', icon: 'schedule' },
  { label: 'Storage', to: '/storage', icon: 'hard_drive' },
  { label: 'Files', to: '/files', icon: 'folder' },
  { label: 'Router', to: '/mc-router', icon: 'alt_route' },
  { label: 'Activity', to: '/activity', icon: 'history' },
];
</script>
