/**
 * Platform bridge — one API for web and Capacitor iOS.
 * On the web everything degrades gracefully (ads simulate instantly, IAP is
 * granted for free in demo mode). In the Capacitor build the same calls go
 * to native plugins / ad SDKs. No tokens or API keys exist in the web bundle.
 */

export interface Platform {
  isNative(): boolean;
  vibrate(ms: number | number[]): void;
  /** show a rewarded video; resolve(true) = reward earned */
  showRewarded(): Promise<boolean>;
  /** show an interstitial (no reward) */
  showInterstitial(): Promise<void>;
  /** IAP: remove ads */
  purchaseRemoveAds(): Promise<boolean>;
  /** IAP: gem packs; returns granted gem count */
  purchaseGems(pack: 1 | 2 | 3): Promise<number>;
  setMusicEnabled(on: boolean): void;
}

/* ------------------------------------------------------------------ */

class WebPlatform implements Platform {
  isNative(): boolean { return false; }
  vibrate(): void { /* web vibration optional; skip to avoid noise */ }

  async showRewarded(): Promise<boolean> {
    // Demo: simulate a 3s ad break with a fake countdown overlay.
    return new Promise(resolve => {
      const ov = document.createElement('div');
      ov.className = 'fake-ad';
      ov.innerHTML = '<div class="fake-ad-box"><div class="fake-ad-title">Rewarded ad (demo)</div><div class="fake-ad-count">3</div><div class="fake-ad-note">Real ads appear in the App Store version.</div></div>';
      document.body.appendChild(ov);
      let n = 3;
      const iv = window.setInterval(() => {
        n--;
        const c = ov.querySelector('.fake-ad-count');
        if (c) c.textContent = String(Math.max(0, n));
        if (n <= 0) {
          window.clearInterval(iv);
          ov.remove();
          resolve(true);
        }
      }, 1000);
    });
  }

  async showInterstitial(): Promise<void> {
    // silent on web
  }

  async purchaseRemoveAds(): Promise<boolean> {
    // demo mode: free
    return true;
  }

  async purchaseGems(pack: 1 | 2 | 3): Promise<number> {
    // demo mode: free grant
    return [0, 500, 1500, 4000][pack];
  }

  setMusicEnabled(_on: boolean): void { /* no-op */ }
}

/* ------------------------------------------------------------------ */

interface HapticsLike { impact: (o: { style: number }) => Promise<void> }
interface AdsLike {
  showRewarded?: () => Promise<{ didEarnReward: boolean }>;
  showInterstitial?: () => Promise<void>;
}
interface IapLike {
  purchase?: (id: string) => Promise<{ ok: boolean; productIds?: string[] }>;
}

class CapacitorPlatform implements Platform {
  private haptics: HapticsLike | null = null;
  private ads: AdsLike | null = null;
  private iap: IapLike | null = null;

  constructor() {
    // Plugins are injected by the native shell via window.Capacitor.
    // The iOS app registers window.__chromalithAds / window.__chromalithIap
    // adapters (AdMob / StoreKit wrappers) before the game boots.
    const w = window as unknown as Record<string, unknown>;
    this.haptics = (w.CapacitorHaptics as HapticsLike) ?? null;
    this.ads = (w.__chromalithAds as AdsLike) ?? null;
    this.iap = (w.__chromalithIap as IapLike) ?? null;
  }

  isNative(): boolean { return true; }

  vibrate(ms: number | number[]): void {
    void this.haptics?.impact({ style: 1 });
    void navigator.vibrate?.(ms);
  }

  async showRewarded(): Promise<boolean> {
    if (!this.ads?.showRewarded) return true; // adapter missing → don't block rewards
    try {
      const r = await this.ads.showRewarded();
      return r.didEarnReward;
    } catch {
      return false;
    }
  }

  async showInterstitial(): Promise<void> {
    try {
      await this.ads?.showInterstitial?.();
    } catch { /* ad not ready */ }
  }

  async purchaseRemoveAds(): Promise<boolean> {
    if (!this.iap?.purchase) return true; // sandbox/demo fallback
    try {
      const r = await this.iap.purchase('removeads.lifetime');
      return r.ok;
    } catch {
      return false;
    }
  }

  async purchaseGems(pack: 1 | 2 | 3): Promise<number> {
    if (!this.iap?.purchase) return [0, 500, 1500, 4000][pack];
    const ids = ['', 'gems.500', 'gems.1500', 'gems.4000'];
    try {
      const r = await this.iap.purchase(ids[pack]);
      return r.ok ? [0, 500, 1500, 4000][pack] : 0;
    } catch {
      return 0;
    }
  }

  setMusicEnabled(on: boolean): void {
    // native side may duck game audio during ads
    void on;
  }
}

/* ------------------------------------------------------------------ */

export function detectPlatform(): Platform {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  const native = typeof window !== 'undefined' && !!cap?.isNativePlatform?.();
  return native ? new CapacitorPlatform() : new WebPlatform();
}

export const platform = detectPlatform();
