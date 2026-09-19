/**
 * Testing Library settings for the whole web suite.
 *
 * `findBy*` and `waitFor` give up after one second by default. The routed
 * student-flow test awaits a dozen UI steps in a row, and on a loaded machine
 * (CI runners, or a laptop running several stacks) one of them can take longer
 * than that without anything being wrong: it failed that way on main at a load
 * average near 40 and passed 3/3 when re-run alone. A higher ceiling changes
 * only how long a *failing* wait takes; a passing one returns as soon as it can.
 */
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });
