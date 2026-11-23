// The slice of Node's test API the unit tests use, so tsc checks them without
// adding @types/node. Tests run under `node --test` (npm run test:editor).
declare module 'node:test' {
  type Body = () => void | Promise<void>;
  const test: (name: string, body: Body) => void;
  export default test;
}

declare module 'node:assert/strict' {
  interface Assert {
    (value: unknown, message?: string): asserts value;
    ok(value: unknown, message?: string): asserts value;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    match(actual: string, pattern: RegExp, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
