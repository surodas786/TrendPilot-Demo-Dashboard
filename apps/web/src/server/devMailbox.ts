/** The local mailbox exposes captured links, so it exists only outside production with an explicit flag. */
export const devMailboxEnabled = () => process.env.NODE_ENV !== 'production' && process.env.DEV_MAILBOX === 'enabled';
