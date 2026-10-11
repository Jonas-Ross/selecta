// The agent picked last, kept per machine so the next brief offers it first.
import { PROVIDER_IDS, type ProviderId, type ProviderStatus } from '../shared/protocol.js';

const REMEMBERED = 'selecta.agent';

export function rememberProvider(id: ProviderId) {
  try {
    localStorage.setItem(REMEMBERED, id);
  } catch {
    // A private or locked storage just means asking again next time.
  }
}

export function rememberedProvider(): ProviderId | undefined {
  try {
    const last = localStorage.getItem(REMEMBERED);

    return PROVIDER_IDS.find((id) => id === last);
  } catch {
    return undefined;
  }
}

/** The last one used if it can still run, else the first that can. */
export function pickProvider(found: ProviderStatus[]): ProviderId | undefined {
  const ready = found.filter((option) => option.ready);
  const last = rememberedProvider();

  return (ready.find((option) => option.id === last) ?? ready[0])?.id;
}
