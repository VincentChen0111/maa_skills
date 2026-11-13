// Test-only preload, loaded before the evaluation fixture's own loaders: any fetch that the trusted network fixture does
// not answer fails, so an "offline" test cannot quietly read the real network. The network fixture, when it serves the
// product entry, replaces fetch after this module; every other process keeps this one.
globalThis.fetch = async () => { throw new Error('offline-test-real-fetch'); };
