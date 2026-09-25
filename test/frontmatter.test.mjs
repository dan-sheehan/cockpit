import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from '../lib/frontmatter.mjs';

test('parses simple frontmatter and body', () => {
  const { data, body } = parseFrontmatter('---\nname: swag\ndescription: One system.\nuser-invocable: true\n---\n# body\n');
  assert.equal(data.name, 'swag');
  assert.equal(data['user-invocable'], true);
  assert.equal(body, '# body\n');
});

test('returns empty data when no frontmatter', () => {
  assert.deepEqual(parseFrontmatter('# hi').data, {});
});
