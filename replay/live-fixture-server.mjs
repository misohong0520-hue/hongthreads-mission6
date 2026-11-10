// Isolated browser-verification fixture, not a production launcher.
process.env.PORT='9252';
await import('./live-test-upstream.mjs');
await import('./server.mjs');
