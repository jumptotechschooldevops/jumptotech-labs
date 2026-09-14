/**
 * A `kubectl` runner for the NetworkPolicy enforcement probe.
 *
 * `spawn` rather than `execFile` because the probe applies manifests through
 * stdin (`kubectl apply -f -`). Argv is an array and there is no shell. Exit
 * codes are data: this never throws.
 */
import { spawn } from 'node:child_process';
import type { KubectlRunner } from './network-enforcement-probe.js';

export function spawnKubectl(options: { kubeconfig?: string; binary?: string } = {}): KubectlRunner {
  return (args, runOptions = {}) =>
    new Promise((resolve) => {
      const env = options.kubeconfig ? { ...process.env, KUBECONFIG: options.kubeconfig } : process.env;
      const child = spawn(options.binary ?? 'kubectl', args, { env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stderr += `\nkubectl timed out after ${runOptions.timeoutMs ?? 60_000}ms`;
        child.kill('SIGKILL');
      }, runOptions.timeoutMs ?? 60_000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: error.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(runOptions.input ?? '');
    });
}
