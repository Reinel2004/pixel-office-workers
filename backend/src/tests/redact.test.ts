// Contact details are removed before a request reaches the AI provider.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactContacts } from '../ai/redact';

test('phone numbers and emails are removed; dates, prices, sizes and order numbers stay', () => {
  const r = redactContacts('Text 09171234567, +63 917 123 4567, 0917-123-4567, (02) 8123 4567, 049 536 1234, +1 415 555 0100 or a.b+c@mail.co.ph');
  assert.equal(r.count, 7);
  assert.ok(!/\d{4}/.test(r.text.replace(/\[[a-z ]+\]/g, '')), r.text);
  const keep = 'ORD-66627F96 due 2026-11-20, ₱25,000.00 or 1500000 centavos, door 36 x 84 in, 2100 x 900 mm';
  assert.deepEqual(redactContacts(keep), { text: keep, count: 0 });
});
