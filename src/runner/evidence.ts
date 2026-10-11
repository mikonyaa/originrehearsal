import type { Page } from 'playwright';
import type { UpgradeCase } from '../config/index.js';
import type { BuildEvidence } from '../models.js';
import type { Gateway } from '../gateway/index.js';
import type { OwnedProfile } from '../profile/index.js';

export function assertIdentity(evidence: BuildEvidence, expectedOrigin: string, expectedProfile: string): void {
  if (evidence.origin !== expectedOrigin) throw new Error(`Origin changed: expected ${expectedOrigin}, observed ${evidence.origin}`);
  if (!evidence.userDataDirConfirmed || evidence.profileId !== expectedProfile) throw new Error('Retained-profile identity mismatch');
  if (!evidence.backendConfirmed) throw new Error('Backend challenge did not confirm the active build');
  if (!evidence.appConfirmed) throw new Error(`Executed app mismatch: expected ${evidence.expectedAppId}, observed ${evidence.executedAppId ?? 'missing sentinel'}`);
}
export async function observeBuild(page: Page, gateway: Gateway, profile: OwnedProfile, app: UpgradeCase['app'], expectedAppId: string): Promise<BuildEvidence> {
  const backend = await gateway.observe();
  await page.locator(app.buildSelector).first().waitFor({ state: 'attached' });
  await page.waitForFunction(({ selector, attribute }) => document.querySelector(selector)?.getAttribute(attribute) !== null, { selector: app.buildSelector, attribute: app.buildAttribute });
  const executedAppId = await page.locator(app.buildSelector).first().getAttribute(app.buildAttribute);
  const serviceWorkers = await page.evaluate(async () => ({
    controller: navigator.serviceWorker?.controller?.scriptURL ?? null,
    registrations: navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope) : [],
  }));
  return { backend, backendConfirmed: true, executedAppId, expectedAppId, appConfirmed: executedAppId === expectedAppId,
    origin: await page.evaluate(() => location.origin), profileId: profile.id, userDataDirConfirmed: profile.confirmed, serviceWorkers };
}
export async function waitReady(page: Page, app: UpgradeCase['app'], timeout: number): Promise<void> {
  if (app.errorSelector) {
    await page.waitForFunction(({ ready, error }) => document.querySelector(ready) || document.querySelector(error), { ready: app.readySelector, error: app.errorSelector }, { timeout });
    const error = page.locator(app.errorSelector).first();
    if (await error.count()) throw new Error(`Application migration/readiness failed: ${await error.getAttribute(app.errorAttribute) ?? await error.textContent()}`);
  } else await page.locator(app.readySelector).first().waitFor({ state: 'attached', timeout });
}
