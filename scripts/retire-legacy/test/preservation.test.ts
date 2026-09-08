import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = new URL('../source/', import.meta.url);
const provenance = JSON.parse(await readFile(new URL('provenance.json', root), 'utf8'));
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('retained closure matches the pinned source and 331 unchanged declarations', async () => {
  let verified = 0;
  for (const file of provenance.files) {
    const text = await readFile(new URL(file.path, root), 'utf8');
    assert.equal(digest(text), file.retainedSha256);
    const source = ts.createSourceFile(file.path, text, ts.ScriptTarget.Latest, true);
    const declarations = new Map<string, string>();
    function visit(node: ts.Node) {
      const topFunction = ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent);
      const method = (ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)) && ts.isClassDeclaration(node.parent);
      const variable = ts.isVariableDeclaration(node) && node.parent.parent.parent && ts.isSourceFile(node.parent.parent.parent);
      if (topFunction || method || variable) {
        const named = node as ts.FunctionDeclaration;
        const parent = node.parent as ts.ClassDeclaration;
        const name = (method ? `${parent.name!.text}.` : '') + (named.name?.getText(source) ?? 'constructor');
        declarations.set(name, digest(node.getText(source)));
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const [name, expected] of Object.entries(file.preservedDeclarations)) {
      assert.equal(declarations.get(name), expected, `${file.path}: ${name}`);
      verified++;
    }
  }
  assert.equal(verified, 331);
  const authority = provenance.files.find((file: { path: string }) => file.path === 'apps/webxd/src/authority.ts');
  for (const method of ['search', 'uncachedSearch', 'searchOne', 'extractSearchHits', 'read', 'uncachedRead', 'readBatch', 'storeRead', 'content', 'readRange', 'crawl']) assert(authority.preservedDeclarations[`WebxAuthority.${method}`]);
  const schemas = provenance.files.find((file: { path: string }) => file.path === 'apps/pi-webx/src/schemas.ts');
  for (const name of ['WebSearchSchema', 'WebReadSchema', 'WebReadAdvancedSchema', 'WebReadBatchSchema', 'WebContentSchema']) assert(schemas.preservedDeclarations[name]);
});
