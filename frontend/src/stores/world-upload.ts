import { defineStore, acceptHMRUpdate } from 'pinia';
import type { SimpleWorld } from '../../../shared/types/worlds';
import { ApiError } from '@/api/http';

export type WorldUploadPhase = 'idle' | 'uploading' | 'processing' | 'succeeded' | 'failed';

export interface WorldUploadState {
  phase: WorldUploadPhase;
  filename: string | null;
  uploadedBytes: number;
  totalBytes: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  result: SimpleWorld | null;
  elapsedSeconds: number;
}

let timerInterval: ReturnType<typeof setInterval> | null = null;

function clearTimer() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

export const useWorldUploadStore = defineStore('world-upload', {
  state: (): WorldUploadState => ({
    phase: 'idle',
    filename: null,
    uploadedBytes: 0,
    totalBytes: 0,
    startedAt: null,
    completedAt: null,
    error: null,
    result: null,
    elapsedSeconds: 0,
  }),

  getters: {
    isActive: (state): boolean => state.phase === 'uploading' || state.phase === 'processing',
    isSettled: (state): boolean => state.phase === 'succeeded' || state.phase === 'failed',
    progressRatio: (state): number => {
      if (state.phase === 'succeeded') return 1;
      if (state.totalBytes > 0) {
        return Math.min(1, Math.max(0, state.uploadedBytes / state.totalBytes));
      }
      return 0;
    },
    progressPct(): number {
      return Math.round(this.progressRatio * 100);
    },
  },

  actions: {
    _updateElapsed() {
      if (!this.startedAt) {
        this.elapsedSeconds = 0;
        return;
      }
      const end = this.completedAt ?? Date.now();
      this.elapsedSeconds = Math.max(0, Math.floor((end - this.startedAt) / 1000));
    },

    _startTimer() {
      clearTimer();
      this._updateElapsed();
      timerInterval = setInterval(() => {
        if (this.isActive) {
          this._updateElapsed();
        } else {
          clearTimer();
        }
      }, 1000);
    },

    reset() {
      clearTimer();
      this.phase = 'idle';
      this.filename = null;
      this.uploadedBytes = 0;
      this.totalBytes = 0;
      this.startedAt = null;
      this.completedAt = null;
      this.error = null;
      this.result = null;
      this.elapsedSeconds = 0;
    },

    dismiss() {
      if (!this.isActive) {
        this.reset();
      }
    },

    upload(file: File, name?: string): Promise<SimpleWorld> {
      if (this.isActive) {
        return Promise.reject(new Error('A world upload is already in progress'));
      }

      this.reset();
      this.phase = 'uploading';
      this.filename = file.name;
      this.totalBytes = file.size;
      this.uploadedBytes = 0;
      this.startedAt = Date.now();
      this._startTimer();

      const formData = new FormData();
      formData.append('file', file);
      if (name) {
        formData.append('name', name);
      }

      return new Promise<SimpleWorld>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/worlds/upload');
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');

        xhr.upload.onprogress = (event: ProgressEvent) => {
          if (event.lengthComputable) {
            this.uploadedBytes = event.loaded;
            this.totalBytes = event.total;
            if (event.loaded >= event.total && this.phase === 'uploading') {
              this.phase = 'processing';
            }
          }
        };

        xhr.upload.onload = () => {
          if (this.phase === 'uploading') {
            this.phase = 'processing';
          }
        };

        xhr.onload = () => {
          clearTimer();
          this.completedAt = Date.now();
          this._updateElapsed();

          let json: { ok?: boolean; world?: SimpleWorld; error?: string } | null = null;
          try {
            json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
          } catch {
            // Non-JSON response
          }

          if (xhr.status >= 200 && xhr.status < 300 && json?.ok && json.world) {
            this.phase = 'succeeded';
            this.result = json.world;
            this.error = null;
            this.uploadedBytes = this.totalBytes;
            resolve(json.world);
          } else {
            this.phase = 'failed';
            const errorMsg = json?.error || xhr.statusText || 'Upload failed';
            this.error = errorMsg;
            this.result = null;
            reject(new ApiError(xhr.status || 500, errorMsg));
          }
        };

        xhr.onerror = () => {
          clearTimer();
          this.completedAt = Date.now();
          this._updateElapsed();
          this.phase = 'failed';
          const errorMsg = 'Network error during world upload';
          this.error = errorMsg;
          this.result = null;
          reject(new ApiError(xhr.status || 0, errorMsg));
        };

        xhr.onabort = () => {
          clearTimer();
          this.completedAt = Date.now();
          this._updateElapsed();
          this.phase = 'failed';
          const errorMsg = 'Upload aborted';
          this.error = errorMsg;
          this.result = null;
          reject(new ApiError(0, errorMsg));
        };

        xhr.send(formData);
      });
    },
  },
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useWorldUploadStore, import.meta.hot));
}
