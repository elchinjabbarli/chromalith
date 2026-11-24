import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.elchinjabbarli.chromalith',
  appName: 'Chromalith',
  webDir: 'docs',
  version: '1.5.0',
  ios: {
    contentInset: 'automatic',
    backgroundColor: '#0d1220',
    limitsScroll: true,
  },
};

export default config;
