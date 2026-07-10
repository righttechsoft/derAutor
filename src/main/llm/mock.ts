import type {
  LlmProvider,
  LlmUsage,
  ProseRequest,
  ProseResult,
  StructuredRequest,
  StructuredResult
} from './types'

/**
 * Deterministic offline provider, active when MOCK_LLM=1.
 * Fixtures are dispatched on schemaName and parameterized by phrases the real
 * prompts are guaranteed to contain (e.g. "exactly N chapters", "chapter N").
 * Every fixture is validated against the caller's zod schema so drift between
 * schemas and fixtures fails loudly in tests.
 */

function mockUsage(model: string): LlmUsage {
  return {
    provider: 'mock',
    model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 1,
    stopReason: 'end_turn'
  }
}

/**
 * The last user message only: real prompts put the dispatch phrase ("chapter N",
 * "exactly N chapters") at its start, while system prefixes and context can
 * contain arbitrary earlier text (including other chapter numbers).
 */
function fullPrompt(req: { messages: { content: string }[] }): string {
  return req.messages.length > 0 ? req.messages[req.messages.length - 1].content : ''
}

function matchInt(text: string, re: RegExp, fallback: number): number {
  const m = text.match(re)
  return m ? parseInt(m[1], 10) : fallback
}

/** Pulls the first "=== CHAPTER N ===" block out of an editOpsUser prompt. */
function firstChapterBlock(prompt: string): { chapter: number; content: string } | null {
  const m = prompt.match(/=== CHAPTER (\d+) ===\n([\s\S]*?)(?=\n=== CHAPTER \d+ ===|$)/)
  if (!m) return null
  return { chapter: parseInt(m[1], 10), content: m[2] }
}

/** A deterministic, verbatim anchor from a chapter's text: the first full sentence. */
function mockAnchor(content: string): string {
  const trimmed = content.trimStart()
  const dot = trimmed.indexOf('.')
  return dot === -1 ? trimmed.slice(0, 60) : trimmed.slice(0, dot + 1)
}

function fixtureFor(schemaName: string, prompt: string): unknown {
  switch (schemaName) {
    case 'clarifyTurn':
      return {
        scratchpad: 'Mock private notes.',
        message:
          'I have reviewed your world and premise. Everything is logical and consistent — I am ready to begin. (mock)',
        ready: true,
        remainingConcerns: []
      }
    case 'clarifyBrief':
      return {
        worldFacts: ['The mock world has two moons.', 'Magic requires spoken words.'],
        premiseRefinements: ['The protagonist starts in the harbor city.'],
        constraints: ['No resurrection of dead characters.'],
        tone: 'adventurous with dark undertones'
      }
    case 'characters':
      return {
        characters: [
          {
            name: 'Aran',
            role: 'protagonist',
            personality: 'Curious, stubborn, secretly afraid of failure.',
            thinkingStyle: 'Notices mechanisms first, people second.',
            voiceSample: 'If the tide tables lie, someone made them lie. (mock)',
            behaviorModel: 'Under pressure he goes quiet and methodical; when lying he over-explains.',
            secrets: ['He copied the harbor master’s key long ago.'],
            arc: 'From lone tinkerer to someone who trusts a crew.',
            visualDescription: 'Wiry young man, salt-bleached brown hair, burn scar on left forearm, patched gray coat.'
          },
          {
            name: 'Mirel',
            role: 'antagonist',
            personality: 'Charming, patient, keeps ledgers of favors.',
            thinkingStyle: 'Thinks in debts and leverage.',
            voiceSample: 'Everyone pays. The only question is the currency. (mock)',
            behaviorModel: 'Never raises her voice; when losing she changes the game.',
            secrets: ['She funds the pirates she publicly hunts.'],
            arc: 'Her network unravels one favor at a time.',
            visualDescription: 'Tall woman, silver-streaked black hair in a crown braid, dark green magistrate robes, jade rings.'
          }
        ]
      }
    case 'outline': {
      const n = matchInt(prompt, /exactly (\d+) chapters/i, 3)
      return {
        bookTitle: 'The Mock Tides',
        acts: [
          { title: 'Act I', summary: 'Setup in the harbor city. (mock)' },
          { title: 'Act II', summary: 'The scheme unravels. (mock)' }
        ],
        twistMap: [
          { description: 'Mirel funds the pirates.', setupChapter: 1, payoffChapter: n }
        ],
        chapters: Array.from({ length: n }, (_, i) => ({
          index: i + 1,
          title: `Chapter ${i + 1} Title (mock)`,
          goal: `Advance the mock plot, step ${i + 1}.`,
          beats: [`Beat A of chapter ${i + 1}`, `Beat B of chapter ${i + 1}`],
          targetWords: matchInt(prompt, /approximately (\d+) words per chapter/i, 600)
        }))
      }
    }
    case 'styleGuide':
      return null // styleGuide is a prose call, not structured
    case 'chapterPlan': {
      const ch = matchInt(prompt, /chapter (\d+)/i, 1)
      return {
        chapter: ch,
        povCharacter: 'Aran',
        scenes: [
          {
            beat: `Mock scene beat for chapter ${ch}.`,
            location: 'Harbor city docks',
            environmentChanges: ['The tide recedes unnaturally far.'],
            innerThoughts: [
              { character: 'Aran', thought: 'The tables are wrong again — third time this week.' }
            ]
          }
        ],
        hiddenWorldEvents: ['Mirel’s ship departs unseen at dawn.'],
        disclosure: [
          { fact: `The tide is wrong in chapter ${ch}.`, level: 'DISCLOSED' },
          { fact: 'Someone altered the tide tables.', level: 'IMPLIED' },
          { fact: 'Mirel altered them.', level: 'HIDDEN' }
        ]
      }
    }
    case 'summaryLedger': {
      const ch = matchInt(prompt, /chapter (\d+)/i, 1)
      return {
        summary:
          `Chapter ${ch} summary (mock): Aran notices the falsified tide tables and begins to investigate. ` +
          'He confronts the harbor clerk, learns nothing, and resolves to watch the docks at night. ' +
          'The chapter ends with an unfamiliar ship slipping out on a tide that should not exist.',
        ledgerUpdates: [
          { fact: `As of chapter ${ch}, Aran knows the tide tables are falsified.`, kind: 'who-knows-what', op: 'add' }
        ],
        timeDelta: '1 day'
      }
    }
    case 'reviewIssues': {
      const round = matchInt(prompt, /review round (\d+)/i, 1)
      if (round === 1) {
        return {
          issues: [
            {
              chapter: 1,
              severity: 'major',
              category: 'continuity',
              description: 'Mock issue: the tide schedule contradicts chapter 1 setup.',
              fixInstruction: 'Align the tide timing with the established schedule.'
            },
            {
              chapter: 2,
              severity: 'minor',
              category: 'pacing',
              description: 'Mock issue: the middle scene drags.',
              fixInstruction: 'Tighten the middle scene by a third.'
            }
          ],
          overallVerdict: 'Solid mock draft; two issues found in round 1.'
        }
      }
      return { issues: [], overallVerdict: 'No remaining issues. (mock)' }
    }
    case 'imageStyleBlock':
      return {
        styleBlock:
          'Muted watercolor illustration, palette anchored on #2b3a4a and #c9a86a, soft dawn lighting, loose ink linework, maritime setting. No text, no watermark, no frames.'
      }
    case 'imagePrompt':
      return {
        sceneDescription: 'Aran on the empty docks at low tide, looking at a departing ship. (mock)',
        prompt: 'A young man in a patched gray coat stands on wet wooden docks at an unnaturally low tide, a dark ship on the horizon at dawn.'
      }
    case 'bookMeta':
      return {
        annotation:
          'In a harbor city ruled by tides, a young tinkerer discovers the tables everyone lives by have been quietly rewritten.\n\nA mock annotation for testing.',
        fb2Genre: 'sf_fantasy',
        authorPseudonym: 'A. Mock'
      }
    case 'translationGlossary':
      return {
        terms: [
          { source: 'Aran', target: 'Aran', note: 'Protagonist name — kept unchanged. (mock)' },
          { source: 'Mirel', target: 'Mirel', note: 'Antagonist name — kept unchanged. (mock)' },
          { source: 'The Mock Tides', target: 'The Mock Tides', note: 'Book/place name. (mock)' }
        ],
        guidance: 'Keep proper nouns as-is; hold a formal, literary register. (mock)'
      }
    case 'translationFrontMatter': {
      const n = matchInt(prompt, /exactly (\d+) chapters/i, 3)
      return {
        bookTitle: 'The Mock Tides (translated)',
        chapterTitles: Array.from({ length: n }, (_, i) => ({
          index: i + 1,
          title: `Chapter ${i + 1} Title (translated, mock)`
        })),
        annotation: 'A translated mock annotation for testing.'
      }
    }
    case 'editOps': {
      const block = firstChapterBlock(prompt)
      if (!block) return { ops: [] }
      const anchor = mockAnchor(block.content)
      const replace = anchor.endsWith('.') ? `${anchor.slice(0, -1)} (edited).` : `${anchor} (edited)`
      return { ops: [{ chapter: block.chapter, find: anchor, replace, reason: 'mock edit' }] }
    }
    case 'continuityConflicts':
      return { conflicts: [] }
    default:
      throw new Error(`Mock provider has no fixture for schema "${schemaName}"`)
  }
}

/** Optional per-call delay so tests can pause/kill mid-pipeline deterministically. */
async function mockDelay(): Promise<void> {
  const ms = parseInt(process.env.MOCK_LLM_DELAY_MS ?? '0', 10)
  if (ms > 0) await new Promise((r) => setTimeout(r, ms))
}

async function structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  if (process.env.DERAUTOR_TRACE === '1') console.error('[mock] structured', req.schemaName)
  await mockDelay()
  const fixture = fixtureFor(req.schemaName, fullPrompt(req))
  if (process.env.DERAUTOR_TRACE === '1') console.error('[mock] fixture ok', req.schemaName)
  const value = req.schema.parse(fixture)
  const usage = mockUsage(req.model)
  req.onUsage?.(usage)
  return { value, usage }
}

async function prose(req: ProseRequest): Promise<ProseResult> {
  await mockDelay()
  const prompt = fullPrompt(req)
  const targetWords = matchInt(prompt, /approximately (\d+) words/i, 200)
  const ch = matchInt(prompt, /chapter (\d+)/i, 0)
  const sentences: string[] = []
  const need = Math.max(20, targetWords)
  let words = 0
  let i = 0
  while (words < need) {
    const s =
      i % 4 === 3
        ? `Aran felt the *wrongness* of the tide in his bones, event ${ch}-${i}.`
        : `The mock story of chapter ${ch} continues with event ${i}, and the harbor holds its breath.`
    sentences.push(s)
    words += s.split(' ').length
    i++
  }
  const paragraphs: string[] = []
  for (let p = 0; p < sentences.length; p += 4) {
    paragraphs.push(sentences.slice(p, p + 4).join(' '))
  }
  const text = paragraphs.join('\n\n')
  if (req.onToken) {
    for (let c = 0; c < text.length; c += 512) req.onToken(text.slice(c, c + 512))
  }
  const usage = mockUsage(req.model)
  req.onUsage?.(usage)
  return { text, usage }
}

export const mockProvider: LlmProvider = { prose, structured }
