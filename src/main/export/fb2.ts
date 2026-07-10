/**
 * Assembles the complete FB2 (FictionBook 2.0) XML for a finished project
 * from current artifacts and stored images. Pure read — no LLM calls.
 */
import { create } from 'xmlbuilder2'
import type { XMLBuilder } from 'xmlbuilder2/lib/interfaces'
import { getProjectRow } from '../db/repo/projects'
import { getAppSettings } from '../services/settings'
import { getChapterArtifacts, getCurrentContent } from '../db/repo/artifacts'
import { listImages } from '../db/repo/images'

const FB2_NS = 'http://www.gribuser.ru/xml/fictionbook/2.0'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'

/**
 * A small subset of the FB2 genre taxonomy. Codes the model proposes are
 * validated against this list; anything unknown falls back to a safe default.
 */
const FB2_GENRES = new Set<string>([
  'sf',
  'sf_history',
  'sf_action',
  'sf_epic',
  'sf_heroic',
  'sf_detective',
  'sf_cyberpunk',
  'sf_space',
  'sf_social',
  'sf_horror',
  'sf_humor',
  'sf_fantasy',
  'fantasy',
  'detective',
  'det_classic',
  'det_police',
  'det_action',
  'det_history',
  'det_espionage',
  'det_crime',
  'thriller',
  'prose_classic',
  'prose_history',
  'prose_contemporary',
  'prose_counter',
  'love_contemporary',
  'love_history',
  'love_detective',
  'love_erotica',
  'adv_western',
  'adv_history',
  'adv_maritime',
  'adv_geo',
  'adv_animal',
  'adventure',
  'child_tale',
  'child_verse',
  'child_prose',
  'child_sf',
  'child_adv',
  'children',
  'antique',
  'antique_myths',
  'sci_history',
  'sci_psychology',
  'sci_culture',
  'sci_religion',
  'sci_philosophy',
  'sci_politics',
  'sci_medicine',
  'sci_tech',
  'comp_programming',
  'reference',
  'nonf_biography',
  'nonf_publicism',
  'nonf_criticism',
  'religion',
  'humor_anecdote',
  'humor_prose',
  'humor_verse',
  'home_cooking',
  'home_health',
  'poetry',
  'dramaturgy',
  'comics'
])

const DEFAULT_GENRE = 'prose_contemporary'

interface BookMeta {
  annotation: string
  fb2Genre: string
  authorPseudonym: string
}

type InlineNode = { kind: 'text' | 'emphasis' | 'strong'; text: string }

/**
 * Builds the FB2 XML document for a finished project. Throws if the project has
 * no finalized chapters yet.
 */
export function buildFb2(projectId: string): string {
  const project = getProjectRow(projectId)
  const chapters = getChapterArtifacts(projectId, 'chapter_final')
  if (chapters.length === 0) {
    throw new Error(`Project ${projectId} has no chapter_final artifacts to export`)
  }

  const outline = parseOutline(getCurrentContent(projectId, 'outline'))
  const meta = parseBookMeta(getCurrentContent(projectId, 'book_meta'))
  const bookTitle = outline.bookTitle || project.title
  const lang = primarySubtag(project.language)
  const genre = FB2_GENRES.has(meta.fb2Genre) ? meta.fb2Genre : DEFAULT_GENRE

  const images = listImages(projectId)
  const cover = images.find((img) => img.kind === 'cover' && img.jpeg != null) ?? null
  const chapterImages = new Map<number, Uint8Array>()
  for (const img of images) {
    if (img.kind === 'chapter' && img.chapter != null && img.jpeg != null) {
      chapterImages.set(img.chapter, img.jpeg)
    }
  }

  const doc = create({ version: '1.0', encoding: 'UTF-8', defaultNamespace: { ele: FB2_NS } })
  const root = doc.ele('FictionBook')
  root.att(XMLNS_NS, 'xmlns:l', XLINK_NS)

  // --- description ---
  const description = root.ele('description')
  const titleInfo = description.ele('title-info')
  titleInfo.ele('genre').txt(genre)
  appendAuthor(titleInfo, getAppSettings().authorName.trim() || meta.authorPseudonym)
  titleInfo.ele('book-title').txt(bookTitle)
  const annotationParas = splitParagraphs(meta.annotation)
  if (annotationParas.length > 0) {
    const annotation = titleInfo.ele('annotation')
    for (const para of annotationParas) {
      appendParagraph(annotation.ele('p'), para)
    }
  }
  // coverpage must precede lang per the FB2 title-info schema order.
  if (cover) {
    imageRef(titleInfo.ele('coverpage').ele('image'), '#cover.jpg')
  }
  titleInfo.ele('lang').txt(lang)

  const now = new Date().toISOString().slice(0, 10)
  const documentInfo = description.ele('document-info')
  documentInfo.ele('author').ele('nickname').txt('derAutor')
  documentInfo.ele('program-used').txt('derAutor')
  documentInfo.ele('date').att('value', now).txt(now.slice(0, 4))
  documentInfo.ele('id').txt(projectId)
  documentInfo.ele('version').txt('1.0')

  // --- body ---
  const body = root.ele('body')
  body.ele('title').ele('p').txt(bookTitle)
  for (const chapter of chapters) {
    const num = chapter.chapter as number
    const section = body.ele('section')
    section.ele('title').ele('p').txt(outline.titles.get(num) ?? `Chapter ${num}`)
    if (chapterImages.has(num)) {
      imageRef(section.ele('image'), `#${chapterBinaryId(num)}`)
    }
    for (const para of splitParagraphs(chapter.content)) {
      appendParagraph(section.ele('p'), para)
    }
  }

  // --- binaries ---
  if (cover) {
    binary(root, 'cover.jpg', cover.jpeg as Uint8Array)
  }
  for (const chapter of chapters) {
    const num = chapter.chapter as number
    const jpeg = chapterImages.get(num)
    if (jpeg) {
      binary(root, chapterBinaryId(num), jpeg)
    }
  }

  return doc.end({ prettyPrint: false })
}

/** "Damien Knox" → first-name/last-name; a single word becomes a nickname. */
function appendAuthor(titleInfo: XMLBuilder, name: string): void {
  const author = titleInfo.ele('author')
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) {
    author.ele('first-name').txt(parts.slice(0, -1).join(' '))
    author.ele('last-name').txt(parts[parts.length - 1])
  } else {
    author.ele('nickname').txt(name)
  }
}

function imageRef(image: XMLBuilder, href: string): void {
  image.att(XLINK_NS, 'l:href', href)
}

function binary(root: XMLBuilder, id: string, jpeg: Uint8Array): void {
  root
    .ele('binary')
    .att('id', id)
    .att('content-type', 'image/jpeg')
    .txt(wrapBase64(Buffer.from(jpeg).toString('base64')))
}

function chapterBinaryId(num: number): string {
  return `ch${String(num).padStart(2, '0')}.jpg`
}

/** Wraps a base64 string at 76 columns for FB2 reader compatibility. */
function wrapBase64(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join('\n')
}

function primarySubtag(language: string): string {
  const primary = language.split('-')[0].trim().toLowerCase()
  return primary || 'en'
}

interface ParsedOutline {
  bookTitle: string
  titles: Map<number, string>
}

function parseOutline(raw: string | null): ParsedOutline {
  const titles = new Map<number, string>()
  if (!raw) return { bookTitle: '', titles }
  try {
    const data = JSON.parse(raw) as {
      bookTitle?: unknown
      chapters?: { index?: unknown; title?: unknown }[]
    }
    const bookTitle = typeof data.bookTitle === 'string' ? data.bookTitle : ''
    if (Array.isArray(data.chapters)) {
      for (const ch of data.chapters) {
        if (typeof ch.index === 'number' && typeof ch.title === 'string') {
          titles.set(ch.index, ch.title)
        }
      }
    }
    return { bookTitle, titles }
  } catch {
    return { bookTitle: '', titles }
  }
}

function parseBookMeta(raw: string | null): BookMeta {
  const fallback: BookMeta = { annotation: '', fb2Genre: DEFAULT_GENRE, authorPseudonym: 'derAutor' }
  if (!raw) return fallback
  try {
    const data = JSON.parse(raw) as Partial<BookMeta>
    return {
      annotation: typeof data.annotation === 'string' ? data.annotation : '',
      fb2Genre: typeof data.fb2Genre === 'string' ? data.fb2Genre : DEFAULT_GENRE,
      authorPseudonym:
        typeof data.authorPseudonym === 'string' && data.authorPseudonym.trim()
          ? data.authorPseudonym
          : 'derAutor'
    }
  } catch {
    return fallback
  }
}

/**
 * Splits markdown-lite text into paragraphs on blank lines. Within each
 * paragraph, heading and inline-code/link markers are stripped and single
 * newlines are collapsed to spaces. Emphasis markers are left in place for
 * appendParagraph to turn into elements.
 */
function splitParagraphs(text: string): string[] {
  // XML 1.0 forbids most control characters; models occasionally emit them.
  // HTML <br> tags become plain line breaks.
  const normalized = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/\r\n?/g, '\n')
  const paragraphs: string[] = []
  for (const block of normalized.split(/\n[ \t]*\n+/)) {
    const lines = block.split('\n').map((line) => line.replace(/^[ \t]*#{1,6}[ \t]*/, ''))
    let joined = lines.join(' ')
    joined = joined.replace(/`([^`]*)`/g, '$1') // inline code
    joined = joined.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links / images
    joined = joined.replace(/[ \t]+/g, ' ').trim()
    if (joined) paragraphs.push(joined)
  }
  return paragraphs
}

/** Appends the markdown-lite inline content of one paragraph to a <p> element. */
function appendParagraph(p: XMLBuilder, para: string): void {
  for (const node of parseInline(para)) {
    if (node.kind === 'text') {
      p.txt(node.text)
    } else {
      p.ele(node.kind).txt(node.text)
    }
  }
}

/**
 * Parses `**strong**` and `*emphasis*` runs from a single paragraph. `**` is
 * matched before `*`; unmatched markers are dropped.
 */
function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let buffer = ''
  let i = 0
  const flush = (): void => {
    if (buffer) {
      nodes.push({ kind: 'text', text: buffer })
      buffer = ''
    }
  }
  // Any asterisks remaining inside a run (nested/mixed markers like
  // '**bold *inner* bold**') would render literally — strip them.
  const inner = (s: string): string => s.replace(/\*/g, '')
  while (i < text.length) {
    if (text.startsWith('***', i)) {
      const end = text.indexOf('***', i + 3)
      if (end > i + 3) {
        flush()
        nodes.push({ kind: 'strong', text: inner(text.slice(i + 3, end)) })
        i = end + 3
        continue
      }
      // no ***-closer: fall through and let the ** branch handle it
    }
    if (text[i] === '*' && text[i + 1] === '*') {
      const end = text.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        nodes.push({ kind: 'strong', text: inner(text.slice(i + 2, end)) })
        i = end + 2
        continue
      }
      i += 2 // unmatched '**' — drop it
      continue
    }
    if (text[i] === '*') {
      const end = text.indexOf('*', i + 1)
      if (end > i + 1) {
        flush()
        nodes.push({ kind: 'emphasis', text: inner(text.slice(i + 1, end)) })
        i = end + 1
        continue
      }
      i += 1 // unmatched '*' — drop it
      continue
    }
    buffer += text[i]
    i += 1
  }
  flush()
  return nodes
}
