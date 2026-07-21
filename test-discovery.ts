// Unit checks for endpoint-discovery inference (no network): OpenAPI parsing +
// error-shape required-field extraction.
//
// Run:  npx tsx test-discovery.ts
import assert from 'node:assert';
import { discoverFromSpec, extractRequiredFields } from './adapter/probeEndpoint.js';

let passed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('OpenAPI spec parsing');
const spec = {
  security: [{ bearer: [] }],
  paths: {
    '/orders': {
      get: {
        parameters: [
          { name: 'branch_id', in: 'query', required: true, description: 'Branch to list orders for', schema: { example: 'b_123' } },
          { name: 'page',      in: 'query', required: false },
        ],
      },
    },
    '/orders/{id}/status': {
      patch: {
        parameters: [{ name: 'id', in: 'path', required: true }],
        requestBody: { content: { 'application/json': { schema: { required: ['status'], properties: { status: { description: 'New status' } } } } } },
      },
    },
  },
};

check('GET /orders → required query param branch_id (not optional page)', () => {
  const r = discoverFromSpec(spec, '/orders', 'GET');
  assert.ok(r);
  assert.equal(r!.authRequired, true);
  assert.deepEqual(r!.fields.map(f => f.name), ['branch_id']);
  assert.equal(r!.fields[0].in, 'query');
  assert.equal(r!.fields[0].example, 'b_123');
});

check('templated path PATCH /orders/123/status matches /orders/{id}/status', () => {
  const r = discoverFromSpec(spec, '/orders/123/status', 'PATCH');
  assert.ok(r);
  // path param is excluded; body required field surfaces
  assert.deepEqual(r!.fields.map(f => f.name), ['status']);
  assert.equal(r!.fields[0].in, 'body');
});

check('unknown path → null', () => {
  assert.equal(discoverFromSpec(spec, '/nonexistent', 'GET'), null);
});

console.log('error-shape field extraction');
check('Laravel/Foodics errors object → required fields', () => {
  const body = { message: 'The given data was invalid.', errors: { branch_id: ['The branch id field is required.'], table: ['required'] } };
  const f = extractRequiredFields(body, 'body').map(x => x.name).sort();
  assert.deepEqual(f, ['branch_id', 'table']);
});

check('JSON:API errors array → parameter names', () => {
  const body = { errors: [
    { source: { parameter: 'location_id' }, detail: 'location_id is required' },
    { source: { pointer: '/data/attributes/customer' }, detail: 'must not be blank' },
  ] };
  const f = extractRequiredFields(body, 'query').map(x => x.name).sort();
  assert.deepEqual(f, ['customer', 'location_id']);
});

check('non-required validation messages are ignored', () => {
  const body = { errors: { email: ['must be a valid email'] } };
  assert.deepEqual(extractRequiredFields(body, 'body'), []);
});

check('non-object body → empty', () => {
  assert.deepEqual(extractRequiredFields('oops', 'body'), []);
});

console.log(`\n${passed} checks passed`);
