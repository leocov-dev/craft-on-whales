<template>
  <q-card class="col-12" style="max-width: 380px">
    <q-card-section class="column items-center q-gutter-y-sm">
      <img src="/icons/splash.png" alt="Craft on Whales" width="120" height="120" />
      <div class="text-subtitle1">Craft on Whales</div>
    </q-card-section>

    <q-card-section>
      <q-banner v-if="error" class="bg-negative text-white q-mb-md" dense rounded>
        {{ error }}
      </q-banner>

      <q-form class="q-gutter-md" @submit="onSubmit">
        <q-input
          v-model="username"
          label="Username"
          autocomplete="username"
          autofocus
          :rules="[(val) => !!val || 'Required']"
        />
        <q-input
          v-model="password"
          label="Password"
          type="password"
          autocomplete="current-password"
          :rules="[(val) => !!val || 'Required']"
        />
        <q-btn
          type="submit"
          color="primary"
          label="Sign in"
          class="full-width"
          :loading="loading"
        />
      </q-form>
    </q-card-section>
  </q-card>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { ApiError } from '@/api/http';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const username = ref('');
const password = ref('');
const loading = ref(false);
const error = ref('');

async function onSubmit() {
  loading.value = true;
  error.value = '';
  try {
    const next = typeof route.query.next === 'string' ? route.query.next : undefined;
    const complete = await auth.login(username.value, password.value, next);
    if (!complete) {
      await router.push({ path: '/login/2fa', query: next ? { next } : {} });
      return;
    }
    await router.push(next && next.startsWith('/') ? next : '/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong.';
  } finally {
    loading.value = false;
  }
}
</script>
