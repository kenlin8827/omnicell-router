/**
 * Bounds shared by the DSH plugin writer and remover.
 *
 * DSH's vendor CLI forwards to pnpm inside the profile. A cold tree can resolve 100+ packages and
 * routinely exceeds two minutes, so DSH gets its own bound while every other runtime keeps the
 * generic install timeout.
 */
export const DSH_TIMEOUT_MS = 15 * 60_000;
