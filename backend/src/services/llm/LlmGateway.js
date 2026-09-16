import { GroundedLocalProvider } from './GroundedLocalProvider.js';

/**
 * LlmGateway — the single doorway into "Layer 6: LLM reasoning /
 * communication" from the product architecture.
 *
 * Cost-free MVP: the grounded-local provider is always available and is
 * the default. A production deployment could register an external
 * provider here (same interface) without touching any caller. The
 * gateway enforces the contract that prompts contain STRUCTURED data,
 * never raw uncontrolled medical text.
 */
export class LlmGateway {
  constructor(providerName = 'grounded-local') {
    this.providers = new Map([['grounded-local', new GroundedLocalProvider()]]);
    this.activeName = providerName;
    if (!this.providers.has(this.activeName)) {
      // Unknown provider configured — fall back to the safe local one instead of crashing.
      console.warn(`LLM provider '${this.activeName}' unknown — using 'grounded-local'.`);
      this.activeName = 'grounded-local';
    }
  }

  get active() {
    return this.providers.get(this.activeName);
  }

  async narrate(task, data) {
    return this.active.generate({ task, data });
  }
}
