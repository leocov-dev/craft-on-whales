<template>
  <q-card class="col-12" style="max-width: 380px">
    <q-card-section class="row items-center justify-center">
      <div class="text-subtitle1">Verify it's you</div>
    </q-card-section>

    <q-card-section>
      <q-banner v-if="error" class="bg-negative text-white q-mb-md" dense rounded>
        {{ error }}
      </q-banner>

      <q-form class="q-gutter-md" @submit="onSubmit">
        <q-input
          v-model="code"
          label="Authentication code"
          autocomplete="one-time-code"
          autofocus
          :rules="[(val) => !!val || 'Required']"
        />
        <q-btn type="submit" color="primary" label="Verify" class="full-width" :loading="loading" />
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

const code = ref('');
const loading = ref(false);
const error = ref('');

async function onSubmit() {
  loading.value = true;
  error.value = '';
  try {
    await auth.loginTotp(code.value);
    const next = typeof route.query.next === 'string' ? route.query.next : undefined;
    await router.push(next && next.startsWith('/') ? next : '/');
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : 'Something went wrong.';
  } finally {
    loading.value = false;
  }
}
</script>
