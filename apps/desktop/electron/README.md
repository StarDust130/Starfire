# Starfire warm realtime voice implementation

## Files

- `realtimeVoice.ts`: complete proposed replacement for `apps/desktop/electron/realtimeVoice.ts`.
- `main-change.patch`: adds startup warm-up in `apps/desktop/electron/main.ts`.
- `test-change.patch`: makes the WebSocket fake acknowledge `session.update` in `apps/desktop/electron/realtimeVoice.test.ts`.

## Apply

1. Back up your current `apps/desktop/electron/realtimeVoice.ts`.
2. Replace it with the supplied `realtimeVoice.ts`.
3. From the repository root, apply the small integration/test changes:

```bash
git apply /path/to/main-change.patch
git apply /path/to/test-change.patch
pnpm verify
```

Then run Starfire and test: warm start, normal activation, stop, interruption, goodbye, provider disconnect, and app shutdown. The supplied code has not been run against your checkout in this environment, so treat it as a proposed implementation to validate—not as already production-tested.
