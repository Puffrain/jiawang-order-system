import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('catalog keeps the role-protected manual product entry visible', async () => {
  const source = await readFile(path.join(process.cwd(), 'app', 'catalog', 'page.tsx'), 'utf8');

  assert.match(source, /user\?\.role !== "viewer"/);
  assert.match(source, /href=\{basePath \+ "\/catalog\/new"\}/);
  assert.match(source, />人工新增商品<\/a>/);
});
