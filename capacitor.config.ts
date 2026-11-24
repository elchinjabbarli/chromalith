import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.elchinjabbarli.chromalith',
  appName: 'Chromalith',
  webDir: 'docs',
  version: '1.1.2',
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0d1220',
    limitsScroll: true,
  },
};

export default config;
