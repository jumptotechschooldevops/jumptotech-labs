/**
 * The contract suite against the in-memory store.
 *
 * This is the implementation used by `npm test` on a laptop with no database
 * running, so holding it to the same suite as PostgreSQL is what stops the
 * fallback quietly becoming a different product.
 */
import { InMemoryProgressRepository } from '../src/memory-repository.js';
import { describeProgressRepository } from './repository-contract.js';

describeProgressRepository('InMemoryProgressRepository', async () => {
  let repository = new InMemoryProgressRepository();
  return {
    get repository() {
      return repository;
    },
    async reset() {
      repository = new InMemoryProgressRepository();
    },
    async close() {
      /* nothing to release */
    },
  };
});
