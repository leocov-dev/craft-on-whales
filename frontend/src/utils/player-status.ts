import type { PlayerStatus } from '@/api/players';

/** Quasar color for each roster `status` badge — shared by PlayersTab and PlayerDetailPage. */
export function playerStatusColor(status: PlayerStatus): string {
  switch (status) {
    case 'Online':
      return 'positive';
    case 'Banned':
      return 'negative';
    case 'Whitelisted':
      return 'info';
    case 'Joined':
      return 'grey-7';
    case 'Unknown':
      return 'grey-5';
  }
}
