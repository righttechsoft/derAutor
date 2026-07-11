import OpenAI, { toFile } from 'openai'
import { getOpenaiKey } from '../services/settings'
import { imageCostUsd } from './pricing'
import { isMockMode } from './provider'

export interface GeneratedImage {
  jpeg: Buffer
  width: number
  height: number
  costUsd: number
}

export interface ImageRequest {
  prompt: string
  orientation: 'portrait' | 'landscape'
  quality: 'low' | 'medium' | 'high'
  /** Fixed style-anchor image (the cover). When set, uses images.edit with it as reference. */
  styleAnchor?: Buffer
  signal?: AbortSignal
}

// 1x1 white JPEG for MOCK_LLM=1 runs
const MOCK_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==',
  'base64'
)

function dims(orientation: 'portrait' | 'landscape'): { width: number; height: number } {
  return orientation === 'portrait' ? { width: 1024, height: 1536 } : { width: 1536, height: 1024 }
}

export async function generateImage(req: ImageRequest): Promise<GeneratedImage> {
  const { width, height } = dims(req.orientation)
  if (isMockMode()) {
    return { jpeg: MOCK_JPEG, width, height, costUsd: 0 }
  }
  const apiKey = getOpenaiKey()
  if (!apiKey) throw new Error('OpenAI API key is not configured (Settings)')
  const client = new OpenAI({ apiKey, maxRetries: 3, timeout: 5 * 60 * 1000 })
  const size = `${width}x${height}` as '1024x1536' | '1536x1024'

  let b64: string | undefined
  if (req.styleAnchor) {
    const result = await client.images.edit(
      {
        model: 'gpt-image-2',
        image: await toFile(req.styleAnchor, 'style-anchor.jpg', { type: 'image/jpeg' }),
        prompt: `Use the attached image ONLY as an art-style reference (palette, linework, rendering). Depict a new scene: ${req.prompt}`,
        size,
        quality: req.quality,
        output_format: 'jpeg'
      },
      { signal: req.signal }
    )
    b64 = result.data?.[0]?.b64_json
  } else {
    const result = await client.images.generate(
      {
        model: 'gpt-image-2',
        prompt: req.prompt,
        size,
        quality: req.quality,
        output_format: 'jpeg'
      },
      { signal: req.signal }
    )
    b64 = result.data?.[0]?.b64_json
  }
  if (!b64) throw new Error('gpt-image-2 returned no image data')
  return { jpeg: Buffer.from(b64, 'base64'), width, height, costUsd: imageCostUsd(req.quality) }
}
