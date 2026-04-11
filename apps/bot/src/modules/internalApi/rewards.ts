import { ParsedRewards } from '../../util';

export const DEFAULT_REWARDS: ParsedRewards = {
  tier: -1,
  rewards: {
    recordHours: 24,
    downloadExpiryHours: 720,
    features: ['mix', 'auto', 'drive', 'glowers', 'eccontinuous', 'ecflac', 'mp3']
  }
};
