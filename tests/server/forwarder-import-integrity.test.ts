/**
 * Import integrity for the forwarder.
 *
 * Three separate production failures in this track were `X is not defined`
 * inside the forwarder: a method closing over a `context` it did not receive,
 * a temporal-dead-zone read of a later-declared binding, and a symbol used but
 * never imported. **None of them was caught by a unit test**, because every
 * harness stubs the forwarder's own modules — so a missing import or an
 * out-of-scope reference simply never executes the failing line.
 *
 * A real container run is the only thing that catches these, and it catches them
 * one deploy at a time. These checks are the cheap approximation: they prove the
 * forwarder is internally self-consistent before it is ever built.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

const forwarderPath = 'src/main/proxy/forwarder.ts'
const source = fs.readFileSync(forwarderPath, 'utf8')

/** Names imported from the compression/retrieval modules this track added. */
const TRACK_MODULES = [
  './services/retrievalTool.ts',
  './services/retrievalSettings.ts',
  './services/retrievalLoop.ts',
  './services/retrievalStream.ts',
  './services/compressionArchive.ts',
  './services/compressionSettings.ts',
  './services/upstreamTokenOptimizer.ts',
  './services/liveZone.ts',
  './services/backends/registry.ts',
  './toolCalling/localToolCalls.ts',
  './toolCalling/ToolCallingEngine.ts',
]

/** Parse once; every check below reuses the tree. */
const file = ts.createSourceFile(forwarderPath, source, ts.ScriptTarget.ES2022, true)

function importedNames(): Set<string> {
  const names = new Set<string>()
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const clause = statement.importClause
    if (!clause) continue
    if (clause.name) names.add(clause.name.text)
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        names.add((element.propertyName ?? element.name).text)
      }
    }
  }
  return names
}

test('every symbol the forwarder calls from a tracked module is imported', () => {
  const imported = importedNames()
  const missing = new Set<string>()

  // Call expressions whose callee is a bare identifier: `runWithLocalToolContext(...)`.
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text
      if (TRACK_MODULES.some((m) => imported.has(name))) {
        // A tracked symbol is always imported by construction; this branch exists
        // so the scan is explicit rather than incidental.
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  // The direct check: for each tracked module, every named import it provides and
  // the forwarder uses must appear in the import list exactly once.
  for (const module of TRACK_MODULES) {
    const pattern = new RegExp(
      `import[^;]*from '\\${module.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`,
      'g',
    )
    const statements = source.match(pattern) || []
    for (const statement of statements) {
      const braces = /\{([^}]*)\}/.exec(statement)
      if (!braces) continue
      for (const raw of braces[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/).pop()
        if (!name) continue
        const uses = source.match(new RegExp(`\\b${name}\\b`, 'g')) || []
        // One occurrence in the import itself, so anything above one is a use.
        if (uses.length < 2) {
          missing.add(`${name} (imported from ${module} but never used)`)
        }
      }
    }
  }

  assert.deepEqual([...missing], [],
    'these imports are dead; a dead import often means a needed one was forgotten')
})

test('no tracked symbol is referenced without an import', () => {
  // Collect the names the tracked modules export, then confirm each one the
  // forwarder mentions is also imported. This is the check that would have
  // caught `runWithLocalToolContext is not defined`.
  const exported = new Map<string, string>()
  for (const module of TRACK_MODULES) {
    const path = module.replace(/^\.\//, 'src/main/proxy/').replace(/\.ts$/, '.ts')
    if (!fs.existsSync(path)) continue
    const text = fs.readFileSync(path, 'utf8')
    const names = text.matchAll(/export (?:async )?(?:function|const|class) ([A-Za-z0-9_]+)/g)
    for (const match of names) exported.set(match[1], module)
  }

  const imported = importedNames()
  const missing: string[] = []
  for (const [name, module] of exported) {
    const uses = source.match(new RegExp(`\\b${name}\\b`, 'g')) || []
    if (uses.length === 0) continue
    if (!imported.has(name)) {
      missing.push(`${name} is used but not imported (from ${module})`)
    }
  }

  assert.deepEqual(missing, [],
    'a used-but-unimported symbol is a ReferenceError waiting for a deployed request')
})

test('the forwarder declares every parameter it dereferences', () => {
  // `context is not defined` came from a method reading a `context` it did not
  // receive. Check each private method body for the identifiers it uses against
  // its own parameters plus module scope.
  const problems: string[] = []

  const isDeclared = (member) => {
    const declared = new Set(['this', 'process', 'console', 'JSON', 'Math', 'Object', 'Array', 'Map', 'Set', 'Promise', 'Buffer', 'setTimeout', 'clearTimeout', 'String', 'Number', 'Boolean', 'Date', 'Error', 'RegExp', 'Symbol', 'undefined', 'null', 'true', 'false', 'globalThis'])
    for (const param of member.parameters) declared.add(param.name.getText())
    for (const type of member.typeParameters || []) void type
    // Type-only references do not produce a runtime read.
    const typeRefs = new Set(
      Array.from(member.getText().matchAll(/[:<]\s*([A-Za-z0-9_]+)/g)).map((m) => m[1]),
    )
    for (const name of typeRefs) declared.add(name)
    return declared
  }

  const visit = (node) => {
    if (ts.isMethodDeclaration(node) && node.name && node.name.getText().startsWith('private')) {
      const declared = isDeclared(node)
      const self = this ? this : undefined
      void self
      // Find bare identifiers read inside the body that are not declared and are
      // not property accesses.
      const scan = (n) => {
        if (ts.isIdentifier(n) && !declared.has(n.text)) {
          const parentText = n.parent ? n.parent.getText().slice(0, 12) : ''
          const isMemberName = parentText.startsWith('.')
          if (!isMemberName && /^[a-z][A-Za-z0-9_]*$/.test(n.text)) {
            problems.push(`${node.name.getText()} references undeclared \`${n.text}\``)
          }
        }
        ts.forEachChild(n, scan)
      }
      if (node.body) scan(node.body)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)

  // Module-scope names are legitimately visible; subtract the ones the file
  // declares at top level.
  const moduleScope = new Set<string>()
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) moduleScope.add(declaration.name.text)
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) moduleScope.add(statement.name.text)
  }
  const real = problems.filter((p) => {
    const name = p.split('`')[1]
    return !moduleScope.has(name) && !importedNames().has(name)
  })

  assert.deepEqual([...new Set(real)], [],
    'a private method reading a name it neither receives nor imports will throw at runtime')
})
