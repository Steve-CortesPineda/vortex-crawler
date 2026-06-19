/**
 * Optional synthetic-fingerprint support for the `rotating` reach profile. Best-effort: if the
 * fingerprint-generator / fingerprint-injector packages aren't installed (or their API drifts),
 * every function degrades to "no injection" so the browser still launches (rotating then behaves
 * like stealth — real proxy egress, no synthetic identity). Never throws.
 *
 * Used ONLY for rotating. natural/stealth deliberately keep the real Chrome fingerprint and never
 * call into here (see stealth-launch.ts).
 */

export interface SyntheticFingerprint {
  userAgent?: string;
  viewport?: { width: number; height: number };
  /** Opaque {fingerprint, headers} bundle passed to the injector. */
  bundle: unknown;
}

/** Generate a coherent desktop-Chrome fingerprint. Returns null if the toolchain is unavailable. */
export async function generateFingerprint(): Promise<SyntheticFingerprint | null> {
  try {
    const { FingerprintGenerator } = await import('fingerprint-generator');
    const gen = new FingerprintGenerator();
    const bundle = gen.getFingerprint({
      browsers: ['chrome'],
      operatingSystems: [process.platform === 'darwin' ? 'macos' : 'windows'],
      devices: ['desktop'],
    });
    const fp = (bundle as { fingerprint?: { navigator?: { userAgent?: string }; screen?: { width: number; height: number } } }).fingerprint;
    return {
      userAgent: fp?.navigator?.userAgent,
      viewport: fp?.screen ? { width: fp.screen.width, height: fp.screen.height } : undefined,
      bundle,
    };
  } catch {
    return null;
  }
}

/** Attach the generated fingerprint's JS overrides to a live Playwright context. Best-effort. */
export async function attachFingerprint(context: unknown, fp: SyntheticFingerprint): Promise<boolean> {
  try {
    const { FingerprintInjector } = await import('fingerprint-injector');
    const injector = new FingerprintInjector();
    await injector.attachFingerprintToPlaywright(context as never, fp.bundle as never);
    return true;
  } catch {
    return false;
  }
}
