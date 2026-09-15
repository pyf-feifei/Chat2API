import assert from 'node:assert/strict'
import test from 'node:test'
import { managedXmlProtocol } from '../../src/main/proxy/toolCalling/protocols/managedXml.ts'
import { unwrapCdata } from '../../src/main/proxy/toolCalling/protocols/shared.ts'
import type { NormalizedToolDefinition } from '../../src/main/proxy/toolCalling/types.ts'

const execTools: NormalizedToolDefinition[] = [
  {
    name: 'exec_command',
    description: 'Run a shell command',
    parameters: {
      type: 'object',
      properties: {
        cmd: { type: 'string' },
        workdir: { type: 'string' },
      },
      required: ['cmd'],
    },
    source: 'openai',
  },
]

function parseInvoke(cmdValue: string) {
  const content = [
    '<|CHAT2API|tool_calls>',
    '<|CHAT2API|invoke name="exec_command">',
    `<|CHAT2API|parameter name="cmd">${cmdValue}</|CHAT2API|parameter>`,
    '<|CHAT2API|parameter name="workdir"><![CDATA[C:\\work]]></|CHAT2API|parameter>',
    '</|CHAT2API|invoke>',
    '</|CHAT2API|tool_calls>',
  ].join('')
  const result = managedXmlProtocol.parse(content, { tools: execTools, protocol: 'managed_xml' })
  assert.equal(result.toolCalls.length, 1, 'expected one parsed tool call')
  return JSON.parse(result.toolCalls[0].function.arguments)
}

test('adjacent CDATA sections concatenate instead of leaking the boundary markers', () => {
  // Regression shape observed in production: the model closed the cmd value
  // with a second (empty) CDATA section and the old anchored regex kept the
  // interior "]]><![CDATA[" in the delivered argument, so the client executed
  // "apply_patch]]><![CDATA[...".  The delivered cmd must be the clean text.
  const body = "$lines = @(\n'*** Begin Patch',\n'+---'\n)\n'@ | apply_patch"
  const args = parseInvoke(`<![CDATA[${body}]]><![CDATA[]]>`)
  assert.equal(args.cmd, body)
  assert.equal(args.workdir, 'C:\\work')
})

test('mid-value CDATA split sections concatenate in order', () => {
  assert.equal(unwrapCdata('<![CDATA[a]]><![CDATA[b]]>'), 'ab')
  assert.equal(unwrapCdata('<![CDATA[part1]]><![CDATA[part2]]><![CDATA[part3]]>'), 'part1part2part3')
})

test('unterminated final CDATA section keeps the text that arrived', () => {
  assert.equal(unwrapCdata('<![CDATA[a]]><![CDATA[b'), 'ab')
  assert.equal(unwrapCdata('<![CDATA[b'), 'b')
})

test('XML escape idiom round-trips a literal close-marker through adjacent sections', () => {
  // "a]]>b" cannot live in one CDATA section; the XML encoding is a]]]]><![CDATA[>b
  assert.equal(unwrapCdata('<![CDATA[a]]]]><![CDATA[>b]]>'), 'a]]>b')
})

test('a literal CDATA opener inside a section is preserved as data', () => {
  assert.equal(unwrapCdata('<![CDATA[grep \'<![CDATA[\' file]]>'), 'grep \'<![CDATA[\' file')
})

test('single wrapped section unwraps identically to the previous behavior', () => {
  assert.equal(unwrapCdata('<![CDATA[/tmp/a]]>'), '/tmp/a')
  assert.equal(unwrapCdata('  <![CDATA[ padded ]]>  '), ' padded ')
})

test('a non-adjacent close/open pair is embedded data, not a section boundary', () => {
  // Only the adjacent "]]><![CDATA[" junction is protocol; free text between
  // a closer and a later opener is literal content (old behavior kept it too).
  assert.equal(unwrapCdata('<![CDATA[x]]> data <![CDATA[y]]>'), 'x]]> data <![CDATA[y')
})

test('plain values never starting with a section pass through untouched', () => {
  assert.equal(unwrapCdata('plain cmd'), 'plain cmd')
  assert.equal(unwrapCdata("mentions ]]><![CDATA[ mid-text but is not wrapped"), "mentions ]]><![CDATA[ mid-text but is not wrapped")
  assert.equal(unwrapCdata('   '), '   ')
})

test('end-to-end: a patch command split across sections parses clean', () => {
  const patchBody = "*** Begin Patch\n*** Add File: skill/SKILL.md\n+---\n+name: fixture\n*** End Patch\n'@ | apply_patch"
  const args = parseInvoke(`<![CDATA[New-Item -ItemType Directory -Force work | Out-Null; @'\n${patchBody}\n]]><![CDATA[]]>`)
  assert.equal(
    args.cmd,
    `New-Item -ItemType Directory -Force work | Out-Null; @'\n${patchBody}`,
  )
  assert.ok(!args.cmd.includes(']]>'))
  assert.ok(!args.cmd.includes('<![CDATA['))
})
