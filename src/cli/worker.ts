import { runCase } from '../runner/index.js';
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
process.once('message', (message: { file: string; out: string; headed: boolean }) => {
  void runCase(message.file, {
    out: message.out, headed: message.headed, signal: controller.signal,
    progress: (phase, reason) => process.send?.({ type: 'progress', phase, reason }),
    onPhase: (phase, timeout) => process.send?.({ type: 'phase', phase, timeout }),
    onOwnedBrowser: (pid, path) => process.send?.({ type: 'browser', pid, path }),
    onOwnedRoot: (root, marker) => process.send?.({ type: 'root', root, marker }),
    onCheckpoint: run => process.send?.({ type: 'checkpoint', run }),
  }).then(run => { process.send?.({ type: 'result', run }, () => process.disconnect()); }, error => {
    process.send?.({ type: 'error', reason: error instanceof Error ? error.message : String(error) }, () => process.disconnect());
  });
});
