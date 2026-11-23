// Fails the type-check when a fixture drifts from its protocol type, in either
// direction: a wrong key, a missing key, or a wrong enum value. Go decodes the
// same files with DisallowUnknownFields in internal/edit/protocol. The literals
// come from fixtures/typed.ts, which `npm run check:editor` generates from the
// JSON first. Running tsc directly without that step fails to find the module.
import type { Check, History, Model, Values } from './protocol';
import { check, history, model, values } from '../fixtures/typed';

/** The four fixtures as their protocol types, for mocks and tests to reuse. */
export const fixtures: { model: Model; check: Check; values: Values; history: History } = { model, check, values, history };
