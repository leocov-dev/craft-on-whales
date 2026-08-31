<template>
  <q-layout view="lHh Lpr lFf">
    <q-header bordered :class="isDark ? 'bg-dark text-white' : 'bg-white text-dark'">
      <q-toolbar style="min-height: 64px">
        <q-btn flat dense round icon="menu" class="lt-lg" @click="drawerOpen = !drawerOpen" />
        <q-toolbar-title
          class="row items-center q-gutter-x-sm cursor-pointer"
          @click="router.push('/')"
        >
          <img src="/icons/craft-on-whales@0.25x.png" alt="" width="40" height="40" />
          <span class="brand-title">Craft on Whales</span>
        </q-toolbar-title>
        <q-btn flat round :icon="isDark ? 'light_mode' : 'dark_mode'" @click="toggleTheme" />
        <q-btn flat round dense class="q-ml-xs">
          <q-avatar size="32px" color="primary" text-color="white">
            {{ userInitials }}
          </q-avatar>
          <q-menu anchor="bottom right" self="top right">
            <q-list style="min-width: 240px">
              <q-item>
                <q-item-section avatar>
                  <q-avatar size="40px" color="primary" text-color="white">
                    {{ userInitials }}
                  </q-avatar>
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ auth.user?.username }}</q-item-label>
                  <q-item-label caption class="row items-center q-gutter-x-xs">
                    <q-badge v-if="auth.role" outline color="primary" :label="auth.role" />
                  </q-item-label>
                </q-item-section>
              </q-item>
              <q-separator />
              <q-item clickable v-close-popup @click="onLogout">
                <q-item-section avatar><q-icon name="logout" /></q-item-section>
                <q-item-section>Sign out</q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </q-toolbar>
    </q-header>

    <q-drawer v-model="drawerOpen" show-if-above bordered :width="220">
      <q-list padding>
        <q-item clickable v-ripple to="/" exact class="text-primary text-weight-medium">
          <q-item-section avatar>
            <q-icon name="home" />
          </q-item-section>
          <q-item-section>Dashboard</q-item-section>
        </q-item>

        <q-separator class="q-my-sm" />

        <q-item v-for="link in navLinks" :key="link.to" clickable v-ripple :to="link.to" exact>
          <q-item-section avatar>
            <q-icon :name="link.icon" />
          </q-item-section>
          <q-item-section>{{ link.label }}</q-item-section>
        </q-item>

        <q-separator class="q-my-sm" />

        <q-item clickable v-ripple to="/settings" exact>
          <q-item-section avatar>
            <q-icon name="settings" />
          </q-item-section>
          <q-item-section>Settings</q-item-section>
        </q-item>

        <q-item v-if="auth.isAdmin" clickable v-ripple to="/users" exact>
          <q-item-section avatar>
            <q-icon name="group" />
          </q-item-section>
          <q-item-section>Users</q-item-section>
        </q-item>
      </q-list>
    </q-drawer>

    <q-page-container>
      <router-view />
    </q-page-container>
  </q-layout>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { currentTheme, setTheme } from '@/boot/theme';

const router = useRouter();
const auth = useAuthStore();

const userInitials = computed(() => {
  const username = auth.user?.username ?? '';
  return username.slice(0, 2).toUpperCase();
});

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
  { label: 'Servers', to: '/servers', icon: 'dns' },
  { label: 'Modpacks', to: '/modpacks', icon: 'inventory_2' },
  { label: 'Worlds', to: '/worlds', icon: 'public' },
  { label: 'Blueprints', to: '/blueprints', icon: 'architecture' },
  { label: 'Updates', to: '/updates', icon: 'upgrade' },
  { label: 'Backups', to: '/backups', icon: 'archive' },
  { label: 'Schedules', to: '/schedules', icon: 'schedule' },
  { label: 'Storage', to: '/storage', icon: 'storage' },
  { label: 'Files', to: '/files', icon: 'folder' },
  { label: 'Router', to: '/mc-router', icon: 'alt_route' },
  { label: 'Activity', to: '/activity', icon: 'history' },
];
</script>

<style scoped>
.brand-title {
  font-family: var(--font-pixel);
  font-weight: 700;
  font-size: 0.9rem;
}
</style>
