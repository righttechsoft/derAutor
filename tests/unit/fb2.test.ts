import { beforeEach, describe, expect, it } from 'vitest'
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces'
import { buildFb2 } from '../../src/main/export/fb2'
import { closeDatabase, initDatabase } from '../../src/main/db/database'
import { createProject } from '../../src/main/db/repo/projects'
import { saveArtifact } from '../../src/main/db/repo/artifacts'
import { saveImage } from '../../src/main/db/repo/images'

const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

interface OutlineChapterSeed {
  index: number
  title: string
}

interface SeedOptions {
  language?: string
  title?: string
  bookTitle?: string
  chapters?: { title: string; content: string }[]
  annotation?: string
  fb2Genre?: string
  authorPseudonym?: string
  cover?: Buffer | null
  chapterImages?: Record<number, Buffer>
  withOutline?: boolean
  withBookMeta?: boolean
  withChapters?: boolean
}

/** A JPEG-ish buffer of the requested length (content is not validated). */
function jpegBuffer(length: number): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, length - head.length), 0x41)])
}

function seedProject(opts: SeedOptions = {}): string {
  const chapters = opts.chapters ?? [
    { title: 'Chapter One', content: 'The first chapter.' },
    { title: 'Chapter Two', content: 'The second chapter.' }
  ]
  const project = createProject({
    title: opts.title ?? 'Working Title',
    language: opts.language ?? 'en-US',
    targetWords: 24000,
    illustrations: true,
    genreHint: '',
    worldInput: 'A world.',
    premiseInput: 'A premise.'
  })

  if (opts.withOutline !== false) {
    const outlineChapters: OutlineChapterSeed[] = chapters.map((c, i) => ({
      index: i + 1,
      title: c.title
    }))
    saveArtifact(
      project.id,
      'outline',
      null,
      JSON.stringify({ bookTitle: opts.bookTitle ?? 'The Final Title', chapters: outlineChapters })
    )
  }

  if (opts.withBookMeta !== false) {
    saveArtifact(
      project.id,
      'book_meta',
      null,
      JSON.stringify({
        annotation: opts.annotation ?? 'A short blurb.',
        fb2Genre: opts.fb2Genre ?? 'sf_fantasy',
        authorPseudonym: opts.authorPseudonym ?? 'Jane Pen'
      })
    )
  }

  if (opts.withChapters !== false) {
    chapters.forEach((c, i) => {
      saveArtifact(project.id, 'chapter_final', i + 1, c.content)
    })
  }

  if (opts.cover) {
    saveImage(project.id, 'cover', null, 'cover prompt', opts.cover, 1024, 1536)
  }
  for (const [chapter, jpeg] of Object.entries(opts.chapterImages ?? {})) {
    saveImage(project.id, 'chapter', Number(chapter), 'chapter prompt', jpeg, 1024, 1024)
  }

  return project.id
}

/** All descendant builders whose element name matches. */
function elementsByName(xml: string, name: string): XMLBuilder[] {
  return create(xml).filter((n) => n.node.nodeName === name, false, true)
}

/** Decoded text content of every element with the given name. */
function textsByName(xml: string, name: string): string[] {
  return elementsByName(xml, name).map((n) => n.node.textContent ?? '')
}

beforeEach(() => {
  closeDatabase()
  initDatabase(':memory:')
})

describe('buildFb2', () => {
  it('produces well-formed XML with the FB2 root and both namespaces', () => {
    const id = seedProject()
    const xml = buildFb2(id)

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
    expect(() => create(xml)).not.toThrow()

    const root = create(xml).root()
    expect(root.node.nodeName).toBe('FictionBook')
    expect((root.node as { namespaceURI?: string | null }).namespaceURI).toBe(FB2_NS)
    expect(xml).toContain(`xmlns="${FB2_NS}"`)
    expect(xml).toContain(`xmlns:l="${XLINK_NS}"`)
  })

  it('escapes special characters and preserves umlauts, Cyrillic, and quotes', () => {
    const id = seedProject({
      chapters: [
        {
          title: 'He said "Hi" & <bye>',
          content: 'Ampersand & less < greater > umlaut ä Größe Cyrillic Привет мир'
        }
      ]
    })
    const xml = buildFb2(id)

    // Reserved characters must be entity-escaped in the raw XML.
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&gt;')
    expect(xml).not.toMatch(/[^&]& /) // no bare ampersand followed by space
    // Non-ASCII stays as literal UTF-8.
    expect(xml).toContain('ä')
    expect(xml).toContain('Größe')
    expect(xml).toContain('Привет')

    // Round-trips back to the original decoded values.
    const paras = textsByName(xml, 'p')
    expect(paras).toContain('Ampersand & less < greater > umlaut ä Größe Cyrillic Привет мир')
    expect(paras).toContain('He said "Hi" & <bye>')
  })

  it('maps markdown-lite: paragraph splitting, emphasis, strong, stripped markers', () => {
    const id = seedProject({
      cover: null,
      chapters: [
        {
          title: 'Prologue',
          content:
            '# Prologue\n\nThe wind was *cold* tonight.\n\nShe whispered **run** and vanished.\n\nA lone star* remains.'
        }
      ]
    })
    const xml = buildFb2(id)

    const paras = textsByName(xml, 'p')
    expect(paras).toContain('Prologue') // heading markers stripped, text kept
    expect(paras).toContain('The wind was cold tonight.')
    expect(paras).toContain('She whispered run and vanished.')
    expect(paras).toContain('A lone star remains.') // stray '*' dropped

    expect(textsByName(xml, 'emphasis')).toContain('cold')
    expect(textsByName(xml, 'strong')).toContain('run')

    // Mixed content round-trips exactly with no injected whitespace.
    expect(xml).toContain('<p>The wind was <emphasis>cold</emphasis> tonight.</p>')
    expect(xml).toContain('<p>She whispered <strong>run</strong> and vanished.</p>')

    // No leftover markdown syntax (no images in this project, so no '#'/'*').
    expect(xml).not.toContain('#')
    expect(xml).not.toContain('*')
  })

  it('embeds cover and chapter images with xlink refs and 76-column base64', () => {
    const id = seedProject({
      cover: jpegBuffer(120),
      chapterImages: { 1: jpegBuffer(90) }
    })
    const xml = buildFb2(id)

    // Cover: binary + coverpage reference through the xlink namespace.
    expect(xml).toContain('<binary id="cover.jpg" content-type="image/jpeg">')
    expect(xml).toContain('l:href="#cover.jpg"')
    expect(xml).toContain('<coverpage>')

    // Chapter 1 image referenced and its binary id matches (zero-padded).
    expect(xml).toContain('l:href="#ch01.jpg"')
    expect(xml).toContain('<binary id="ch01.jpg" content-type="image/jpeg">')
    // Chapter 2 has no image.
    expect(xml).not.toContain('#ch02.jpg')

    // Base64 payload is wrapped: multiple lines, each at most 76 columns.
    const coverBinary = elementsByName(xml, 'binary').find(
      (n) =>
        (n.node as unknown as { getAttribute(name: string): string | null }).getAttribute('id') ===
        'cover.jpg'
    )
    expect(coverBinary).toBeDefined()
    const lines = (coverBinary!.node.textContent ?? '').split('\n')
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(76)
    }
  })

  it('falls back to prose_contemporary for an unknown genre and keeps valid ones', () => {
    const badId = seedProject({ fb2Genre: 'totally_made_up_code' })
    expect(textsByName(buildFb2(badId), 'genre')).toContain('prose_contemporary')

    const goodId = seedProject({ fb2Genre: 'detective' })
    expect(textsByName(buildFb2(goodId), 'genre')).toContain('detective')
  })

  it('reduces the project language to its primary subtag', () => {
    const id = seedProject({ language: 'ru-RU' })
    const xml = buildFb2(id)
    expect(xml).toContain('<lang>ru</lang>')
    expect(textsByName(xml, 'lang')).toContain('ru')
  })

  it('uses sensible fallbacks when book_meta and outline are missing', () => {
    const id = seedProject({
      withOutline: false,
      withBookMeta: false,
      title: 'Fallback Title',
      chapters: [{ title: 'ignored', content: 'Body.' }]
    })
    const xml = buildFb2(id)

    expect(textsByName(xml, 'genre')).toContain('prose_contemporary')
    expect(textsByName(xml, 'book-title')).toContain('Fallback Title')
    // Chapter title falls back to "Chapter N" when no outline is present.
    expect(textsByName(xml, 'p')).toContain('Chapter 1')
    // Author nickname in title-info falls back to 'derAutor'.
    expect(textsByName(xml, 'nickname')).toContain('derAutor')
  })

  it('throws when the project has no finalized chapters', () => {
    const id = seedProject({ withChapters: false })
    expect(() => buildFb2(id)).toThrow(/no chapter_final/)
  })
})
